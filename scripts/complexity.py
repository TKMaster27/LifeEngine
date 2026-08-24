"""Statistics relating ENVIRONMENT complexity to ORGANISM complexity.

The dashboard already measures both halves; nothing here re-reads a result file.
It takes the per-seed reduction (`dashboard.sweep_seed_stats`) and the measured
landscape descriptors (`scripts/landscape_metrics.py`) as DataFrames and does
the inference. Kept Streamlit-free and, deliberately, **it must not import
`dashboard`** -- that module calls `st.set_page_config`, `st.title` and builds
its sidebar at import time, so importing it launches a page.

Three decisions are baked in because getting them wrong is the easiest way to
report a result that isn't there:

  UNIT OF ANALYSIS.  Five seeds share a condition, and the `normal`/`predation`
  arms share the *same map*. So the replicate for anything correlated against a
  landscape property is the LANDSCAPE (18 of them behind 36 conditions), with
  arm as a within-landscape factor. Correlating at the seed level would treat 52
  points as independent when there are ~14, inflating significance by about an
  order of magnitude. `landscape_means` collapses to that unit and every test
  here consumes its output.

  SURVIVORS ONLY.  71% of the random sweep went extinct. Extinct runs have no
  body to measure, so they are filtered once, on entry, matching the existing
  `aggregate_seeds` convention. That makes every result CONDITIONAL ON SURVIVAL:
  harsh landscapes are represented only by their luckiest seeds, which biases
  slopes toward zero. Reported, not corrected.

  SMALL n.  Fourteen landscapes need |rho| >= 0.53 for p<.05 before any
  multiplicity correction. Every function returns its n alongside its estimate
  so nothing can be quoted without it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

# Landscape descriptors worth offering as an x-axis, with why.
ENV_AXES = {
    "switch_cost": "Extra travel to a second food type (cells)",
    "mean_dist_to_food": "Mean distance to nearest food (cells)",
    "mean_island_spacing": "Mean spacing between food patches (cells)",
    "dist_to_2nd_type": "Distance to a second food type (cells)",
    "emitters_total": "Food supply (emitters)",
    "islands": "Food patches",
}
# Deliberately absent: `open_regions` and `largest_open_fraction` take only the
# values {1,2,3,5} and {0.997..1.000} across the fleet -- contour ribbons almost
# never fragment the map, so they carry no usable variance.

ORGANISM_METRICS = {
    "av_cells": "Body size (cells / organism)",
    "nonmouth_cells": "Body size excluding mouths (cells)",
    "mouth_cells": "Mouth cells / organism",
    "cell_entropy": "Body composition entropy (bits)",
    "cell_richness": "Cell-type richness",
    "connections": "Brain connections",
    "hidden_nodes": "Brain hidden nodes",
}

DIET_OUTCOMES = {
    # Default first. Breadth is where the signal is, and it is the honest label
    # for it: "how many food types the average organism eats".
    "plant_breadth": "Plant-diet breadth (types / organism)",
    # The radiation measure proper: population Shannon over species grouped by
    # their diet SET, so one generalist species scores 0 and three coexisting
    # specialist lineages score log2(3). Nearly orthogonal to breadth
    # (rho ~ 0.08), which is the point.
    "niche_shannon": "Niche diversity — radiation (bits)",
    "niche_count": "Niches occupied (>=5% of pop)",
    # NOT a radiation measure: per-type population shares cannot distinguish
    # one generalist eating three types from three specialists, and it tracks
    # breadth at rho ~ 0.8. Kept for continuity, labelled for what it is.
    "diet_shannon": "Diet-type spread (bits)",
    "diet_types_held": "Plant types held (>=5% of pop)",
    "species_count": "Species alive",
    "specialist_pct": "Plant specialists (% pop)",
}

# The index is over independent axes: mouth_cells + nonmouth_cells = av_cells,
# so including all three would weight body size twice.
OCI_INPUTS = ["av_cells", "cell_entropy", "cell_richness", "connections",
              "hidden_nodes"]


def survivors(df: pd.DataFrame) -> pd.DataFrame:
    """The one place the survivor rule is applied."""
    if "extinct" not in df.columns:
        return df.copy()
    return df.loc[~df["extinct"].astype(bool)].copy()


def landscape_means(df: pd.DataFrame, cols=None, pool_arms=True) -> pd.DataFrame:
    """Survivors collapsed to the unit of analysis. `n_seeds` rides along so a
    mean over one lucky seed is never mistaken for a mean over five.

    `pool_arms=True` (the default, and the strict reading) gives one row per
    LANDSCAPE: the predation sibling is the same map, so keeping the arms apart
    would enter a landscape twice into a correlation against its own measured
    properties. Set False to keep (landscape, arm) rows when arm is the thing
    being compared -- more rows, but they are not fully independent.
    """
    d = survivors(df)
    if d.empty:
        return d
    keys = ["landscape_id"] if pool_arms else [k for k in ("landscape_id", "arm")
                                               if k in d.columns]
    keys = [k for k in keys if k in d.columns]
    if not keys:
        return d
    num = [c for c in (cols or d.columns)
           if c in d.columns and pd.api.types.is_numeric_dtype(d[c])]
    out = d.groupby(keys, as_index=False)[num].mean()
    out["n_seeds"] = d.groupby(keys).size().to_numpy()
    for c in ("env_class", "scale", "scarcity", "replicate", "arm"):
        if c in keys:
            continue
        if c in d.columns:
            first = d.groupby(keys)[c].first().to_numpy()
            out[c] = first
    return out


def _clean_pair(df, x, y):
    if x not in df.columns or y not in df.columns:
        return np.array([]), np.array([])
    sub = df[[x, y]].apply(pd.to_numeric, errors="coerce").dropna()
    return sub[x].to_numpy(), sub[y].to_numpy()


def spearman(df: pd.DataFrame, x: str, y: str) -> dict:
    a, b = _clean_pair(df, x, y)
    # Constant input makes rho undefined -- report it as such rather than NaN.
    if len(a) < 4 or np.ptp(a) == 0 or np.ptp(b) == 0:
        return {"x": x, "y": y, "rho": np.nan, "p": np.nan, "n": int(len(a))}
    r = stats.spearmanr(a, b)
    return {"x": x, "y": y, "rho": float(r.statistic), "p": float(r.pvalue),
            "n": int(len(a))}


def spearman_matrix(df: pd.DataFrame, ycols, xcols, alpha=0.05) -> pd.DataFrame:
    """Every organism metric against every environment/diet axis, with
    Benjamini-Hochberg across the whole family. BH rather than Bonferroni
    because these tests are positively correlated and the question is
    exploratory: which relationships are worth following up."""
    rows = [spearman(df, x, y) for y in ycols for x in xcols]
    out = pd.DataFrame(rows)
    ok = out["p"].notna()
    out["q"] = np.nan
    if ok.any():
        out.loc[ok, "q"] = stats.false_discovery_control(out.loc[ok, "p"].to_numpy(),
                                                         method="bh")
    out["significant"] = out["q"] < alpha
    return out


def bootstrap_rho(df, x, y, n_boot=2000, seed=0, level=0.95):
    """Percentile CI, resampling LANDSCAPES -- resampling seeds would rebuild
    the pseudoreplication this module exists to avoid."""
    d = df.dropna(subset=[x, y]) if x in df.columns and y in df.columns else pd.DataFrame()
    if len(d) < 4:
        return (np.nan, np.nan)
    unit = "landscape_id" if "landscape_id" in d.columns else None
    groups = [g for _, g in d.groupby(unit)] if unit else [d.iloc[[i]] for i in range(len(d))]
    if len(groups) < 4:
        return (np.nan, np.nan)
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(groups), len(groups))
        s = pd.concat([groups[i] for i in pick])
        a, b = s[x].to_numpy(), s[y].to_numpy()
        if np.ptp(a) == 0 or np.ptp(b) == 0:
            continue
        out.append(stats.spearmanr(a, b).statistic)
    if len(out) < 100:
        return (np.nan, np.nan)
    lo, hi = (1 - level) / 2 * 100, (1 + level) / 2 * 100
    return (float(np.nanpercentile(out, lo)), float(np.nanpercentile(out, hi)))


def partial_spearman(df: pd.DataFrame, x: str, y: str, control: str) -> dict:
    """Rank-residual partial correlation: rho(x, y) with `control` removed from
    both. EXPLORATORY. At n~14 this cannot separate mediation from confounding,
    and endpoint correlations carry no temporal order -- establishing that the
    environment acts on morphology *through* diet needs the within-run series
    (`diet_timeseries` in the dashboard), not this."""
    cols = [x, y, control]
    if any(c not in df.columns for c in cols):
        return {"rho": np.nan, "partial": np.nan, "n": 0}
    sub = df[cols].apply(pd.to_numeric, errors="coerce").dropna()
    if len(sub) < 5:
        return {"rho": np.nan, "partial": np.nan, "n": int(len(sub))}
    rx, ry, rc = (stats.rankdata(sub[c].to_numpy()) for c in cols)
    if np.ptp(rc) == 0 or np.ptp(rx) == 0 or np.ptp(ry) == 0:
        return {"rho": np.nan, "partial": np.nan, "n": int(len(sub))}
    ex = rx - np.polyval(np.polyfit(rc, rx, 1), rc)
    ey = ry - np.polyval(np.polyfit(rc, ry, 1), rc)
    raw = stats.spearmanr(sub[x], sub[y])
    if np.ptp(ex) == 0 or np.ptp(ey) == 0:
        return {"rho": float(raw.statistic), "partial": np.nan, "n": int(len(sub))}
    par = stats.pearsonr(ex, ey)          # on ranks-residuals == partial Spearman
    return {"rho": float(raw.statistic), "p_rho": float(raw.pvalue),
            "partial": float(par.statistic), "p_partial": float(par.pvalue),
            "n": int(len(sub)), "control": control}


def group_test(df: pd.DataFrame, value: str, group: str, min_n=3) -> dict:
    """Kruskal-Wallis across groups, with epsilon-squared.

    Refuses rather than tests when a group is too small: with unbalanced cells
    this size, a KW driven by an n=1 group is noise wearing a p-value."""
    if value not in df.columns or group not in df.columns:
        return {"ok": False, "reason": "missing column"}
    sub = df[[value, group]].dropna()
    sizes = sub.groupby(group).size()
    usable = sizes[sizes >= min_n]
    out = {"sizes": sizes.to_dict(), "dropped": sizes[sizes < min_n].to_dict(),
           "min_n": min_n}
    if len(usable) < 2:
        return {**out, "ok": False,
                "reason": f"fewer than 2 groups with n>={min_n}"}
    samples = [sub.loc[sub[group] == g, value].to_numpy() for g in usable.index]
    pooled = np.concatenate(samples)
    # A metric that never varies (av_hidden_nodes is a constant 4.0 across every
    # surviving run) makes kruskal return nan. Printed, that reads as "tested,
    # no difference" -- the opposite of the truth, which is "not testable".
    if np.ptp(pooled) == 0:
        return {**out, "ok": False,
                "reason": f"{value} is constant ({pooled[0]:g}) — nothing to compare"}
    h = stats.kruskal(*samples)
    if not np.isfinite(h.statistic) or not np.isfinite(h.pvalue):
        return {**out, "ok": False, "reason": "test undefined for these groups"}
    n = int(sum(len(s) for s in samples))
    k = len(samples)
    # epsilon^2 = (H - k + 1) / (n - k); the standard rank effect size for KW.
    eps2 = (float(h.statistic) - k + 1) / (n - k) if n > k else np.nan
    return {**out, "ok": True, "H": float(h.statistic), "p": float(h.pvalue),
            "eps2": float(np.clip(eps2, 0, 1)), "n": n, "groups": k,
            "tested": list(usable.index)}


def theil_sen(x, y):
    """Median-of-slopes fit: robust to the handful of extreme landscapes, and it
    assumes nothing about the residual distribution, unlike OLS."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 3 or np.ptp(x[m]) == 0:
        return None
    res = stats.theilslopes(y[m], x[m])
    return {"slope": float(res[0]), "intercept": float(res[1]),
            "lo": float(res[2]), "hi": float(res[3])}


def organism_index(df: pd.DataFrame, cols=None):
    """PC1 of the z-scored organism metrics, via SVD (no sklearn).

    Sign-oriented so body size loads positive. Expect PC1 to be largely a SIZE
    axis -- the loadings are returned so it can be described as what it is
    rather than asserted to be "complexity"."""
    cols = [c for c in (cols or OCI_INPUTS) if c in df.columns]
    sub = df[cols].apply(pd.to_numeric, errors="coerce")
    ok = sub.dropna()
    if len(ok) < 4 or len(cols) < 2:
        return pd.Series(np.nan, index=df.index), {}
    z = (ok - ok.mean()) / ok.std(ddof=0).replace(0, np.nan)
    z = z.dropna(axis=1, how="all").fillna(0.0)
    U, S, Vt = np.linalg.svd(z.to_numpy(), full_matrices=False)
    pc1 = Vt[0]
    if "av_cells" in z.columns and pc1[list(z.columns).index("av_cells")] < 0:
        pc1, U = -pc1, -U
    scores = pd.Series(np.nan, index=df.index, dtype=float)
    scores.loc[ok.index] = U[:, 0] * S[0]
    info = {"loadings": dict(zip(z.columns, np.round(pc1, 3))),
            "explained": float(S[0] ** 2 / (S ** 2).sum()), "n": int(len(ok))}
    return scores, info


# ── assembling the analysis table ──────────────────────────────────────────
RING_PREFIX = "map_500_d"

# The values the baseline experiment runs at; anything else is a different
# experiment on the same landscape (scripts/generate_diet_sweep.py,
# scripts/generate_meat_sweep.py).
BASELINE_DIET_PENALTY   = 1.0
BASELINE_MEAT_NUTRITION = 1.0


def env_class(env: str) -> str:
    return "simple_ring" if env.startswith(RING_PREFIX) else "complex_random"


def attach_landscape(seed_df: pd.DataFrame, land_df: pd.DataFrame) -> pd.DataFrame:
    """Join measured landscape descriptors onto per-seed rows.

    Adds the two keys everything downstream depends on and that are easy to
    forget: `condition_id` (5 seeds share it) and `landscape_id` (BOTH ARMS
    share it -- the predation sibling is the same map, so there are 18
    landscapes behind 36 conditions, not 36).
    """
    df = seed_df.copy()
    if "env" not in df.columns:
        raise ValueError("seed table needs an `env` column")
    df["condition_id"] = df["env"]
    df["landscape_id"] = df["env"].str.replace("_predation", "", regex=False)
    df["env_class"] = df["env"].map(env_class)
    # `label_rand` only labels rand_* envs, so ring rows arrive with arm unset.
    # Left NaN, they would be silently dropped by every groupby("arm") --
    # the simple family would just disappear from the plots. Derive it from the
    # env name for any row that lacks one.
    from_name = np.where(df["env"].str.contains("_predation"), "predation", "normal")
    if "arm" not in df.columns:
        df["arm"] = from_name
    else:
        df["arm"] = df["arm"].fillna(pd.Series(from_name, index=df.index))

    if land_df is None or land_df.empty:
        df["comparable_baseline"] = True
        return df
    land = land_df.copy()
    keep = [c for c in land.columns
            if c not in ("map_path", "size", "metrics_version", "map_sha1")]
    land = land[keep].rename(columns={"map": "env"})
    # One row per env, defensively. The merge below is a LEFT join on `env`, so a
    # table listing the same map twice -- which is what an older
    # landscape_metrics.py produced once maps/random_near duplicated twelve of
    # maps/random_sweep's landscapes -- would duplicate every seed of those envs
    # and quietly inflate the n behind every statistic on the page.
    land = land.drop_duplicates(subset="env", keep="first")
    # Landscape descriptors are properties of the MAP, so join on the map the
    # env was run from -- which for a predation arm is its own file.
    out = df.merge(land, on="env", how="left", suffixes=("", "_land"))

    # The diet-penalty and meat sweeps reuse ONE map and vary the fitness rules,
    # so their folders look like environments but are not: pooling them would
    # answer "does the diet penalty change bodies?" while claiming to answer
    # "does the landscape change bodies?". Read the controls off the map rather
    # than pattern-matching the folder name, which would miss a renamed sweep.
    out["comparable_baseline"] = (
        out.get("diet_penalty_exponent").eq(BASELINE_DIET_PENALTY).fillna(True)
        & out.get("meat_nutrition").eq(BASELINE_MEAT_NUTRITION).fillna(True)
    ) if "diet_penalty_exponent" in out.columns else True
    return out
