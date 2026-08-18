"""
Life Engine Explorer
====================
Interactive dashboard for Life Engine simulation output (one JSON per seed).

Run with:
    uv run streamlit run scripts/dashboard.py

By default it looks in ./results — the same layout the CHPC sweep produces:

    results/
    ├── map_500_d01/
    │   ├── seed_1.json
    │   ├── seed_2.json
    │   └── ...
    ├── map_500_d02/
    └── ...

Views:
    Single seed      — every chart from analyze_results.py, interactive
    Overlay runs     — overlay any chosen runs on a single metric
    Environment      — mean ± SD bands across seeds within one environment
    Compare envs     — side-by-side env summaries (extinction, richness, etc.)
    Diet-penalty     — the a/n^p sweep: specialisation vs. penalty steepness,
                       and what the steepness costs the population
    Morphology       — the random-environment sweep: does a harder landscape
                       build a more complex organism?
    Meat sweep       — predator/scavenger emergence vs. meat nutrition
    Summary          — every run in the folder, one row each

Memory / performance notes (matters for full 10M-tick records, ~145 MB each):
  - Files parse to ~400 MB in RAM. We parse ONCE, extract only the compact
    series we plot, then discard the raw object. Only the small derived
    bundle (a few MB) is cached, and the cache is bounded.
  - Time series are decimated to TARGET_POINTS for display.
  - The cross-seed / cross-env summary view reads ONLY the cheap top-level
    summary fields (via ijson if installed) — never the 145 MB body.
  - The two sweep views summarise 50-180 seeds at once, so they never take the
    full-parse route at all: each seed is streamed with ijson and reduced to a
    few dozen numbers, cached to disk (see sweep_seed_stats).
"""

import os
import re
import json
import math
from collections import defaultdict

import numpy as np
import pandas as pd
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go

try:
    import ijson
    HAVE_IJSON = True
except Exception:
    HAVE_IJSON = False

st.set_page_config(
    page_title="Life Engine Explorer",
    layout="wide",
    page_icon="🧬",
    initial_sidebar_state="expanded",
)

# ── Tuning ──────────────────────────────────────────────────────────────────
TARGET_POINTS    = 3000     # display resolution for time series
TOP_SPECIES      = 12       # species shown individually before grouping "other"
MAX_CACHED_SEEDS = 6        # bound the derived-data cache
DEFAULT_FOLDER   = "results"

# ── Palette (matches scripts/analyze_results.py for visual consistency) ─────
DIET_KEYS = ["type0_only", "type1_only", "type2_only", "type3_only", "generalist", "none"]
DIET_LABELS = {
    "type0_only": "Type 0 specialists",
    "type1_only": "Type 1 specialists",
    "type2_only": "Type 2 specialists",
    "type3_only": "Type 3 specialists",
    "generalist": "Generalists",
    "none":       "No diet / mouth",
}
DIET_COLOURS = {
    DIET_LABELS["type0_only"]: "#1f77ff",
    DIET_LABELS["type1_only"]: "#FF69B4",
    DIET_LABELS["type2_only"]: "#FF0000",
    DIET_LABELS["type3_only"]: "#FFD500",
    DIET_LABELS["generalist"]: "#15DE59",
    DIET_LABELS["none"]:       "#888888",
}
DIET_ORDER = [DIET_LABELS[k] for k in DIET_KEYS]

CELL_TYPES   = ["mouth", "producer", "mover", "killer", "armor", "eye"]
CELL_COLOURS = {
    "mouth":    "#DE3641",
    "producer": "#15DE59",
    "mover":    "#60D4FF",
    "killer":   "#F2317A",
    "armor":    "#7230DB",
    "eye":      "#E6E6E6",
}

SCALAR_LABELS = {
    "pop_counts":      "Total population",
    "species_counts":  "Number of species",
    "av_mut_rates":    "Avg mutation rate",
    "av_cells":        "Avg cells / organism",
    "av_connections":  "Avg NN connections",
    "av_hidden_nodes": "Avg NN hidden nodes",
}

PLOTLY_TEMPLATE = "plotly_white"
LAYOUT_DEFAULTS = dict(
    margin=dict(l=10, r=10, t=50, b=10),
    legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
    font=dict(family="Inter, system-ui, sans-serif", size=13),
    hovermode="x unified",
)

# ── Light CSS polish ────────────────────────────────────────────────────────
st.markdown(
    """
    <style>
      .block-container {padding-top: 1.2rem; padding-bottom: 2rem; max-width: 1400px;}
      h1, h2, h3 {letter-spacing: -0.01em;}
      [data-testid="stMetricValue"] {font-size: 1.4rem;}
      [data-testid="stMetricLabel"] {color: #666;}
      .small-caption {color: #888; font-size: 0.85rem;}
      div[data-testid="stRadio"] label, div[data-testid="stCheckbox"] label {
          font-size: 0.9rem;
      }
    </style>
    """,
    unsafe_allow_html=True,
)


# ── Decimation ──────────────────────────────────────────────────────────────
def keep_ticks(ticks, target=TARGET_POINTS):
    uniq = list(dict.fromkeys(ticks))
    if len(uniq) <= target:
        return set(uniq)
    k = math.ceil(len(uniq) / target)
    kept = set(uniq[::k])
    kept.add(uniq[-1])
    return kept


# ── Transforms (run once per file, on the raw dict, then discarded) ─────────
def scalar_frame(records, kept):
    cols = {"tick": records.get("tick_record", [])}
    for key in SCALAR_LABELS:
        if key in records:
            cols[key] = records[key]
    n = min(len(v) for v in cols.values())
    cols = {k: v[:n] for k, v in cols.items()}
    df = pd.DataFrame(cols)
    df = df.loc[~df["tick"].duplicated(keep="last")]
    df = df[df["tick"].isin(kept)].reset_index(drop=True)
    return df


def dict_column_long(records, key, kept, label_map=None, only=None):
    tick = records.get("tick_record", [])
    col = records.get(key, [])
    n = min(len(tick), len(col))
    rows = []
    for i in range(n):
        t = tick[i]
        if t not in kept:
            continue
        d = col[i]
        if not isinstance(d, dict) or not d:
            continue
        for cat, val in d.items():
            if only is not None and cat not in only:
                continue
            rows.append({"tick": t,
                         "category": (label_map or {}).get(cat, cat),
                         "value": val})
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.drop_duplicates(subset=["tick", "category"], keep="last")
    return df


def species_population_long(records, kept, top_n=TOP_SPECIES):
    tick = records.get("tick_record", [])
    col = records.get("species_populations", [])
    n = min(len(tick), len(col))
    peak = {}
    for i in range(n):
        d = col[i]
        if isinstance(d, dict):
            for sp, pop in d.items():
                if pop > peak.get(sp, 0):
                    peak[sp] = pop
    top = set(sorted(peak, key=peak.get, reverse=True)[:top_n])
    rows = []
    for i in range(n):
        if tick[i] not in kept:
            continue
        d = col[i]
        if not isinstance(d, dict):
            continue
        for sp, pop in d.items():
            rows.append({"tick": tick[i],
                         "species": sp if sp in top else "other",
                         "value": pop})
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.groupby(["tick", "species"], as_index=False)["value"].sum()


SPEC_LABELS = [DIET_LABELS[k] for k in ("type0_only", "type1_only", "type2_only", "type3_only")]
GEN_LABEL   = DIET_LABELS["generalist"]
NONE_LABEL  = DIET_LABELS["none"]


def diet_composites(diet_long):
    """From a long [tick, category, value] diet frame, derive specialisation
    composites over time.

    Returns a wide DataFrame with columns:
        tick, Generalist (%), Specialist (%), Dominant specialist (%),
        Specialist Shannon H
    """
    if diet_long is None or diet_long.empty:
        return pd.DataFrame()
    pivot = (diet_long.pivot_table(index="tick", columns="category",
                                   values="value", aggfunc="last")
                      .fillna(0))
    total = pivot.sum(axis=1).replace(0, np.nan)
    spec_cols = [c for c in SPEC_LABELS if c in pivot.columns]
    spec_sum  = pivot[spec_cols].sum(axis=1) if spec_cols else pd.Series(0, index=pivot.index)
    gen       = pivot.get(GEN_LABEL, pd.Series(0, index=pivot.index))

    out = pd.DataFrame(index=pivot.index)
    out["Generalist (%)"]           = gen / total * 100
    out["Specialist (%)"]           = spec_sum / total * 100
    if spec_cols:
        out["Dominant specialist (%)"]  = pivot[spec_cols].max(axis=1) / total * 100
        spec_p = pivot[spec_cols].div(spec_sum.replace(0, np.nan), axis=0)
        H = -(spec_p * np.log(spec_p.replace(0, np.nan))).sum(axis=1)
        out["Specialist Shannon H"]     = H
    return out.reset_index()


def species_table(fr):
    species = fr.get("species", {})
    diets   = fr.get("species_diets", {})
    rows = []
    for sp, info in species.items():
        rows.append({
            "species": sp,
            "extinct": info.get("extinct"),
            "start_tick": info.get("start_tick"),
            "end_tick": info.get("end_tick"),
            "lifespan": (info.get("end_tick") or 0) - (info.get("start_tick") or 0),
            "cumulative_pop": info.get("cumulative_pop"),
            "final_pop": info.get("population"),
            "diet": diets.get(sp),
        })
    return pd.DataFrame(rows)


@st.cache_data(show_spinner="Parsing and preparing seed…", max_entries=MAX_CACHED_SEEDS)
def prepare(path=None, raw=None, name="", sig=None):
    """Parse one seed and return a COMPACT bundle. The 400 MB raw dict is
    local to this function and freed on return; only the small bundle is cached.

    `sig` is the file's (mtime, size) — unused in the body, present only so the
    cache invalidates when the file behind `path` changes (see _file_sig)."""
    d = json.loads(raw) if raw is not None else json.load(open(path))
    fr = d.get("fossil_record", {})
    records = fr.get("records", {})
    ticks = records.get("tick_record", [])
    kept = keep_ticks(ticks)

    diet_pop     = dict_column_long(records, "population_diet_counts", kept, DIET_LABELS)
    diet_species = dict_column_long(records, "species_diet_counts",    kept, DIET_LABELS)
    bundle = {
        "name": name,
        "meta": {k: d.get(k) for k in
                 ("seed", "total_ticks", "reached_max_ticks", "extinction_tick",
                  "final_population", "final_species", "ticks_per_second",
                  "peak_rss_mb")},
        "n_samples":      len(set(ticks)),
        "n_shown":        len(kept),
        "scalars":        scalar_frame(records, kept),
        "diet_pop":       diet_pop,
        "diet_species":   diet_species,
        "diet_composite_pop":     diet_composites(diet_pop),
        "diet_composite_species": diet_composites(diet_species),
        "cells":          dict_column_long(records, "av_cell_counts", kept, only=CELL_TYPES),
        "species_pop":    species_population_long(records, kept),
        "species_tbl":    species_table(fr),
    }
    return bundle  # raw `d` goes out of scope here -> reclaimed


# ── Cheap final-tick diet snapshot (for the cross-env outcome view) ────────
@st.cache_data(show_spinner=False)
def final_diet_stats(path, sig=None):
    """Return a dict of {generalist_pct, specialist_pct, dominant_specialist_pct,
    dominant_diet, and raw counts per category} for the LAST recorded tick of
    one seed. Uses ijson to stream the diet array without loading the full
    fossil_record body where possible."""
    last = None
    try:
        if HAVE_IJSON:
            with open(path, "rb") as f:
                for item in ijson.items(f, "fossil_record.records.population_diet_counts.item"):
                    last = item
        else:
            with open(path) as f:
                d = json.load(f)
            arr = (d.get("fossil_record", {}).get("records", {})
                    .get("population_diet_counts", []))
            last = arr[-1] if arr else None
    except Exception:
        return None
    if not isinstance(last, dict) or not last:
        return None
    total = sum(v for v in last.values() if isinstance(v, (int, float)))
    if not total:
        return None
    gen = last.get("generalist", 0)
    specs = {k: last.get(k, 0) for k in ("type0_only", "type1_only", "type2_only", "type3_only")}
    spec_total = sum(specs.values())
    dom_key = max(specs, key=specs.get) if spec_total else ("generalist" if gen else "none")
    out = {
        "total":                   total,
        "generalist_pct":          gen / total * 100,
        "specialist_pct":          spec_total / total * 100,
        "dominant_specialist_pct": (max(specs.values()) / total * 100) if spec_total else 0.0,
        "dominant_diet":           DIET_LABELS.get(dom_key, dom_key),
    }
    for k, v in last.items():
        out[f"raw_{k}"] = v
    return out


# ── Cheap summary (skips heavy sections) ───────────────────────────────────
SUMMARY_KEYS = ("seed", "total_ticks", "reached_max_ticks", "extinction_tick",
                "final_population", "final_species", "ticks_per_second", "peak_rss_mb")


def _summary_ijson(path):
    found, want = {}, set(SUMMARY_KEYS)
    with open(path, "rb") as f:
        for prefix, event, value in ijson.parse(f):
            if prefix in want and event in ("number", "boolean", "string", "null"):
                found[prefix] = value
                if len(found) == len(want):
                    break
    return found


def _summary_json(path):
    """Fallback if ijson isn't installed. Loads the whole file."""
    with open(path) as f:
        d = json.load(f)
    return {k: d.get(k) for k in SUMMARY_KEYS}


# ── Discovery ──────────────────────────────────────────────────────────────
def _file_sig(path):
    """(mtime, size) for a file — folded into cache keys so that swapping the
    contents behind an identical path (e.g. renaming results1/ -> results/, or
    regenerating a seed in place) busts the cache instead of serving the stale
    parse. Streamlit's @st.cache_data keys on argument *values*, not file
    contents, so without this a path string that hasn't changed always hits."""
    try:
        s = os.stat(path)
        return (s.st_mtime, s.st_size)
    except OSError:
        return (0.0, 0)


def discover_layout(folder):
    """Return (envs, flat) where envs is {env_name: [paths]} based on the
    results/<env>/seed_*.json convention, and flat is the bare top-level list.

    seed_*.json files are matched at *any* depth below `folder`, not just one
    level down, so the layout still resolves when a download wraps the results
    tree in an extra directory (e.g. results/results/<env>/seed_*.json, or an
    archive that expanded one level deep). Each file is grouped under the name
    of its *immediate parent* directory — the env name in the
    results/<env>/seed_*.json convention — so the grouping is unchanged for the
    normal one-level layout. Files sitting directly in `folder` are returned as
    `flat` (any *.json there, for back-compat with loose result files).
    `*_world.json` snapshots (which live under worlds/) are always excluded."""
    envs = {}
    flat = []
    if not os.path.isdir(folder):
        return envs, flat
    top = os.path.abspath(folder)
    for root, dirs, files in os.walk(folder):
        # Prune noise we never want to descend into, and keep traversal ordered.
        dirs[:] = sorted(d for d in dirs
                         if not d.startswith(".") and d != "node_modules")
        if os.path.abspath(root) == top:
            flat = sorted(
                os.path.join(root, f) for f in files
                if f.endswith(".json") and not f.endswith("_world.json")
            )
            continue
        seeds = sorted(
            os.path.join(root, f) for f in files
            if f.startswith("seed_") and f.endswith(".json")
            and not f.endswith("_world.json")
        )
        if seeds:
            env = os.path.basename(root)
            envs.setdefault(env, []).extend(seeds)
    for env in envs:
        envs[env].sort()
    return dict(sorted(envs.items())), flat


@st.cache_data(show_spinner="Reading summaries…")
def scan_paths(paths_tuple, sigs_tuple=None):
    # sigs_tuple is unused in the body; it parallels paths_tuple purely so the
    # cached summary table refreshes when any underlying file changes.
    rows = []
    for fp in paths_tuple:
        try:
            d = _summary_ijson(fp) if HAVE_IJSON else _summary_json(fp)
        except Exception as exc:
            rows.append({"file": os.path.basename(fp), "path": fp,
                         "error": str(exc)})
            continue
        reached = bool(d.get("reached_max_ticks"))
        rows.append({
            "file": os.path.basename(fp),
            "path": fp,
            "env": os.path.basename(os.path.dirname(fp)),
            "seed": d.get("seed"),
            "total_ticks": d.get("total_ticks"),
            "survived": reached,
            "extinction_tick": None if reached else d.get("extinction_tick"),
            "final_population": d.get("final_population"),
            "final_species": d.get("final_species"),
            "ticks_per_second": d.get("ticks_per_second"),
            "peak_rss_mb": d.get("peak_rss_mb"),
        })
    return pd.DataFrame(rows)


# ── Single-seed view ───────────────────────────────────────────────────────
def styled(fig, title=None):
    fig.update_layout(template=PLOTLY_TEMPLATE, **LAYOUT_DEFAULTS)
    if title:
        fig.update_layout(title=dict(text=title, x=0.0, xanchor="left", font=dict(size=15)))
    return fig


def render_single(b):
    m = b["meta"]
    reached = bool(m.get("reached_max_ticks"))
    st.subheader(f"Seed {m.get('seed')}  ·  {b['name']}")
    if b["n_samples"] > b["n_shown"]:
        st.caption(f"Showing {b['n_shown']:,} of {b['n_samples']:,} time samples "
                   f"(decimated for smooth rendering).")
    c = st.columns(6)
    c[0].metric("Total ticks",     f"{m.get('total_ticks', 0):,}")
    c[1].metric("Outcome",         "Survived" if reached else "Extinct")
    c[2].metric("Extinction tick", "—" if reached else f"{m.get('extinction_tick', 0):,}")
    c[3].metric("Final population", f"{m.get('final_population', 0):,}")
    c[4].metric("Final species",    f"{m.get('final_species', 0):,}")
    c[5].metric("Peak RAM (sim)",   f"{m.get('peak_rss_mb', 0) or 0:,.0f} MB")

    sdf = b["scalars"]
    t1, t2, t3, t4, t5 = st.tabs(
        ["Population & species", "Diet specialisation", "Body composition",
         "Per-species", "Evolution & species table"])

    with t1:
        col1, col2 = st.columns(2)
        if "pop_counts" in sdf:
            fig = px.line(sdf, x="tick", y="pop_counts",
                          labels={"tick": "Tick", "pop_counts": "Population"})
            fig.update_traces(line_color="#4e79a7", line_width=2)
            col1.plotly_chart(styled(fig, "Total population over time"),
                              use_container_width=True)
        if "species_counts" in sdf:
            fig = px.line(sdf, x="tick", y="species_counts",
                          labels={"tick": "Tick", "species_counts": "Species"})
            fig.update_traces(line_color="#59a14f", line_width=2)
            col2.plotly_chart(styled(fig, "Species richness over time"),
                              use_container_width=True)

    with t2:
        level = st.radio("Count by", ["Population", "Number of species"],
                         horizontal=True, key="diet_level")
        ddf = b["diet_pop"] if level == "Population" else b["diet_species"]
        if ddf.empty:
            st.info("No diet data recorded for this seed.")
        else:
            fig = px.line(ddf, x="tick", y="value", color="category",
                          category_orders={"category": DIET_ORDER},
                          color_discrete_map=DIET_COLOURS,
                          labels={"tick": "Tick", "value": level, "category": "Diet"})
            fig.update_traces(line_width=1.8)
            st.plotly_chart(styled(fig, f"Diet specialisation over time ({level.lower()})"),
                            use_container_width=True)

    with t3:
        cdf = b["cells"]
        if cdf.empty:
            st.info("No cell-composition data recorded for this seed.")
        else:
            fig = px.line(cdf, x="tick", y="value", color="category",
                          category_orders={"category": CELL_TYPES},
                          color_discrete_map=CELL_COLOURS,
                          labels={"tick": "Tick", "value": "Avg cells", "category": "Cell type"})
            fig.update_traces(line_width=1.8)
            st.plotly_chart(styled(fig, "Average body composition over time"),
                            use_container_width=True)

    with t4:
        spdf = b["species_pop"]
        if spdf.empty:
            st.info("No per-species population data recorded for this seed.")
        else:
            fig = px.line(spdf, x="tick", y="value", color="species",
                          labels={"tick": "Tick", "value": "Population", "species": "Species"})
            fig.update_traces(line_width=1.5)
            st.plotly_chart(styled(fig, f"Population by species (top {TOP_SPECIES}; rest as 'other')"),
                            use_container_width=True)

    with t5:
        col1, col2 = st.columns(2)
        for ax, keys in ((col1, ["av_mut_rates", "av_cells"]),
                         (col2, ["av_connections", "av_hidden_nodes"])):
            present = [k for k in keys if k in sdf]
            if present:
                long = sdf.melt(id_vars="tick", value_vars=present,
                                var_name="metric", value_name="value")
                long["metric"] = long["metric"].map(SCALAR_LABELS)
                fig = px.line(long, x="tick", y="value", color="metric",
                              labels={"tick": "Tick", "value": ""})
                ax.plotly_chart(styled(fig), use_container_width=True)
        tbl = b["species_tbl"]
        if not tbl.empty:
            st.markdown(f"**Species detail** ({len(tbl):,} species)")
            st.dataframe(tbl.sort_values("cumulative_pop", ascending=False),
                         use_container_width=True, hide_index=True)


# ── Cross-seed summary (all runs, every env) ───────────────────────────────
def render_summary(envs, flat):
    paths = []
    for v in envs.values():
        paths.extend(v)
    paths.extend([p for p in flat if p not in paths])
    if not paths:
        st.warning("No seed JSON files found under that folder.")
        return
    df = scan_paths(tuple(paths), tuple(_file_sig(p) for p in paths))
    if df.empty:
        st.warning("No readable seed files.")
        return
    if "error" in df.columns:
        bad = df[df["error"].notna()] if "error" in df else pd.DataFrame()
        if not bad.empty:
            st.error(f"{len(bad)} files failed to parse.")
            df = df[df["error"].isna()].drop(columns=["error"])

    st.subheader(f"All runs — {len(df)} seed files across {df['env'].nunique()} environment(s)")
    if not HAVE_IJSON:
        st.caption("Tip: `uv add ijson` makes this view much faster on full "
                   "records (reads only the summary fields, not the 145 MB body).")

    c = st.columns(4)
    c[0].metric("Runs", len(df))
    c[1].metric("Survived to max", int(df["survived"].sum()))
    c[2].metric("Went extinct",    int((~df["survived"]).sum()))
    med = df.loc[~df["survived"], "extinction_tick"].median()
    c[3].metric("Median extinction tick", f"{med:,.0f}" if pd.notna(med) else "—")

    col1, col2 = st.columns(2)
    ext = df.loc[~df["survived"]].dropna(subset=["extinction_tick"])
    if not ext.empty:
        fig = px.histogram(ext, x="extinction_tick", color="env", barmode="overlay",
                           opacity=0.6, nbins=30,
                           labels={"extinction_tick": "Extinction tick", "env": "Environment"})
        col1.plotly_chart(styled(fig, "Distribution of extinction times"),
                          use_container_width=True)
    fig = px.scatter(df, x="final_species", y="final_population",
                     color="env", symbol="survived", hover_data=["seed", "file"],
                     labels={"final_species": "Final species",
                             "final_population": "Final population",
                             "env": "Environment", "survived": "Survived"})
    col2.plotly_chart(styled(fig, "Final population vs species richness"),
                      use_container_width=True)

    st.markdown("**All runs (sortable)**")
    show = df.drop(columns=["path"]).sort_values(["env", "seed"])
    st.dataframe(show, use_container_width=True, hide_index=True)


# ── Environment view — mean ± SD bands across seeds in one env ─────────────
def _scalar_band(bundles, key, label):
    frames = []
    for b in bundles:
        sdf = b["scalars"]
        if key not in sdf.columns:
            continue
        s = sdf[["tick", key]].rename(columns={key: "value"})
        s["seed"] = f"seed {b['meta'].get('seed')}"
        frames.append(s)
    if not frames:
        return None
    df = pd.concat(frames, ignore_index=True)
    pivot = df.pivot_table(index="tick", columns="seed", values="value", aggfunc="last")
    pivot = pivot.sort_index().ffill()
    mean = pivot.mean(axis=1)
    std  = pivot.std(axis=1)
    upper, lower = mean + std, mean - std
    fig = go.Figure()
    fig.add_traces([
        go.Scatter(x=upper.index, y=upper.values, line=dict(width=0),
                   showlegend=False, hoverinfo="skip"),
        go.Scatter(x=lower.index, y=lower.values, line=dict(width=0),
                   fill="tonexty", fillcolor="rgba(78,121,167,0.18)",
                   name="±1 SD", hoverinfo="skip"),
        go.Scatter(x=mean.index, y=mean.values, line=dict(color="#4e79a7", width=2),
                   name="Mean across seeds"),
    ])
    for col in pivot.columns:
        fig.add_trace(go.Scatter(
            x=pivot.index, y=pivot[col], name=col, mode="lines",
            opacity=0.35, line=dict(width=1, dash="dot")))
    fig.update_layout(xaxis_title="Tick", yaxis_title=label)
    return fig


def _composite_band(bundles, bundle_key, col, ylab, colour="#4e79a7"):
    """Mean ± SD across seeds for one column of a per-bundle wide frame
    (e.g. b["diet_composite_pop"]["Generalist (%)"]).
    """
    frames = []
    for b in bundles:
        comp = b.get(bundle_key)
        if comp is None or comp.empty or col not in comp.columns:
            continue
        s = comp[["tick", col]].rename(columns={col: "value"})
        s["seed"] = f"seed {b['meta'].get('seed')}"
        frames.append(s)
    if not frames:
        return None
    df = pd.concat(frames, ignore_index=True)
    pivot = df.pivot_table(index="tick", columns="seed", values="value", aggfunc="last")
    pivot = pivot.sort_index().ffill()
    mean = pivot.mean(axis=1)
    std  = pivot.std(axis=1)
    upper, lower = mean + std, mean - std

    def _rgba(hex_c, alpha):
        hex_c = hex_c.lstrip("#")
        r, g, b_ = int(hex_c[0:2], 16), int(hex_c[2:4], 16), int(hex_c[4:6], 16)
        return f"rgba({r},{g},{b_},{alpha})"

    fig = go.Figure()
    fig.add_traces([
        go.Scatter(x=upper.index, y=upper.values, line=dict(width=0),
                   showlegend=False, hoverinfo="skip"),
        go.Scatter(x=lower.index, y=lower.values, line=dict(width=0),
                   fill="tonexty", fillcolor=_rgba(colour, 0.18),
                   name="±1 SD", hoverinfo="skip"),
        go.Scatter(x=mean.index, y=mean.values,
                   line=dict(color=colour, width=2),
                   name="Mean across seeds"),
    ])
    for col_name in pivot.columns:
        fig.add_trace(go.Scatter(
            x=pivot.index, y=pivot[col_name], name=col_name, mode="lines",
            opacity=0.35, line=dict(width=1, dash="dot")))
    fig.update_layout(xaxis_title="Tick", yaxis_title=ylab)
    return fig


def _gen_vs_spec_band(bundles):
    """Two mean ± SD bands on one chart — Generalist (%) vs Specialist (%)."""
    gen_frames, spec_frames = [], []
    for b in bundles:
        comp = b.get("diet_composite_pop")
        if comp is None or comp.empty:
            continue
        seed = f"seed {b['meta'].get('seed')}"
        if "Generalist (%)" in comp.columns:
            f = comp[["tick", "Generalist (%)"]].rename(columns={"Generalist (%)": "value"})
            f["seed"] = seed; gen_frames.append(f)
        if "Specialist (%)" in comp.columns:
            f = comp[["tick", "Specialist (%)"]].rename(columns={"Specialist (%)": "value"})
            f["seed"] = seed; spec_frames.append(f)
    if not gen_frames and not spec_frames:
        return None

    def _band(frames, colour, name):
        df = pd.concat(frames, ignore_index=True)
        pivot = df.pivot_table(index="tick", columns="seed",
                               values="value", aggfunc="last").sort_index().ffill()
        mean = pivot.mean(axis=1); std = pivot.std(axis=1)
        hex_c = colour.lstrip("#")
        r, g, b_ = int(hex_c[0:2], 16), int(hex_c[2:4], 16), int(hex_c[4:6], 16)
        fill = f"rgba({r},{g},{b_},0.18)"
        return [
            go.Scatter(x=(mean + std).index, y=(mean + std).values,
                       line=dict(width=0), showlegend=False, hoverinfo="skip"),
            go.Scatter(x=(mean - std).index, y=(mean - std).values,
                       line=dict(width=0), fill="tonexty", fillcolor=fill,
                       name=f"{name} ±1 SD", hoverinfo="skip"),
            go.Scatter(x=mean.index, y=mean.values, mode="lines",
                       line=dict(color=colour, width=2.2), name=f"{name} mean"),
        ]

    fig = go.Figure()
    if spec_frames:
        for tr in _band(spec_frames, "#1f77ff", "Specialist"):
            fig.add_trace(tr)
    if gen_frames:
        for tr in _band(gen_frames, "#15DE59", "Generalist"):
            fig.add_trace(tr)
    fig.update_layout(xaxis_title="Tick", yaxis_title="% of population",
                      yaxis=dict(range=[0, 100]))
    return fig


def _diet_band(bundles, share_of_population=True):
    """Stacked diet share over time, averaged across seeds."""
    long_frames = []
    for b in bundles:
        dd = b["diet_pop"]
        if dd.empty:
            continue
        tot = dd.groupby("tick")["value"].sum().rename("total")
        joined = dd.join(tot, on="tick")
        if share_of_population:
            joined["frac"] = joined["value"] / joined["total"].replace(0, np.nan)
        else:
            joined["frac"] = joined["value"]
        joined["seed"] = f"seed {b['meta'].get('seed')}"
        long_frames.append(joined[["tick", "category", "frac", "seed"]])
    if not long_frames:
        return None
    big = pd.concat(long_frames, ignore_index=True)
    mean = big.groupby(["tick", "category"], as_index=False)["frac"].mean()
    if share_of_population:
        mean["frac"] = mean["frac"] * 100.0
        ylab = "Share of population (%)"
    else:
        ylab = "Average count"
    fig = px.area(mean, x="tick", y="frac", color="category",
                  category_orders={"category": DIET_ORDER},
                  color_discrete_map=DIET_COLOURS,
                  labels={"tick": "Tick", "frac": ylab, "category": "Diet"})
    return fig


def render_environment(envs):
    if not envs:
        st.warning("No environments detected. Expected `results/<env>/seed_*.json`.")
        return
    env = st.selectbox("Environment", list(envs.keys()))
    files = envs[env]
    chosen = st.multiselect("Seeds to include",
                            files,
                            default=files,
                            format_func=os.path.basename)
    if not chosen:
        st.info("Pick one or more seeds above.")
        return
    bundles = [prepare(path=fp, name=os.path.basename(fp), sig=_file_sig(fp))
               for fp in chosen]
    metas = [b["meta"] for b in bundles]
    survived = sum(1 for m in metas if m.get("reached_max_ticks"))
    extinct  = len(metas) - survived
    final_pop = np.mean([m.get("final_population") or 0 for m in metas])
    final_sp  = np.mean([m.get("final_species") or 0 for m in metas])

    st.subheader(f"{env} — {len(bundles)} seed(s)")
    c = st.columns(4)
    c[0].metric("Seeds",            len(bundles))
    c[1].metric("Survived / extinct", f"{survived} / {extinct}")
    c[2].metric("Mean final pop",   f"{final_pop:,.0f}")
    c[3].metric("Mean final species", f"{final_sp:,.0f}")

    t1, t2, t_spec, t3 = st.tabs(["Population & species (mean ± SD)",
                                  "Diet specialisation (mean share)",
                                  "Specialisation composites",
                                  "Other metrics"])

    with t1:
        col1, col2 = st.columns(2)
        f = _scalar_band(bundles, "pop_counts", "Population")
        if f: col1.plotly_chart(styled(f, "Population — mean ± SD across seeds"),
                                use_container_width=True)
        f = _scalar_band(bundles, "species_counts", "Species")
        if f: col2.plotly_chart(styled(f, "Species richness — mean ± SD"),
                                use_container_width=True)

    with t2:
        share = st.toggle("As share of population (%)", value=True, key="diet_share")
        f = _diet_band(bundles, share_of_population=share)
        if f is None:
            st.info("No diet data in these seeds.")
        else:
            st.plotly_chart(styled(f, "Mean diet specialisation across seeds"),
                            use_container_width=True)

    with t_spec:
        st.caption(
            "Composite specialisation metrics derived from the diet shares. "
            "**Generalist** = mouths that eat any food type (1/√n absorption penalty). "
            "**Dominant specialist** = whichever single specialist diet holds the largest "
            "share of the population — captures *which* food type 'won'. "
            "**Shannon H** across the four specialist diets — higher = more balanced "
            "split between specialists, lower = one specialist dominates."
        )
        f = _gen_vs_spec_band(bundles)
        if f is None:
            st.info("No diet data in these seeds.")
        else:
            st.plotly_chart(styled(f, "Generalist vs Specialist share — mean ± SD"),
                            use_container_width=True)
        col1, col2 = st.columns(2)
        f = _composite_band(bundles, "diet_composite_pop", "Dominant specialist (%)",
                            "Dominant specialist (%)", colour="#FF0000")
        if f: col1.plotly_chart(styled(f, "Dominant specialist share — mean ± SD"),
                                use_container_width=True)
        f = _composite_band(bundles, "diet_composite_pop", "Specialist Shannon H",
                            "Shannon H (specialist diets)", colour="#7230DB")
        if f: col2.plotly_chart(styled(f, "Specialist diet diversity — mean ± SD"),
                                use_container_width=True)

    with t3:
        col1, col2 = st.columns(2)
        f = _scalar_band(bundles, "av_cells", "Avg cells / organism")
        if f: col1.plotly_chart(styled(f, "Avg organism size"), use_container_width=True)
        f = _scalar_band(bundles, "av_mut_rates", "Mutation rate")
        if f: col2.plotly_chart(styled(f, "Avg mutation rate"), use_container_width=True)
        col1, col2 = st.columns(2)
        f = _scalar_band(bundles, "av_connections", "Connections")
        if f: col1.plotly_chart(styled(f, "Avg NN connections"), use_container_width=True)
        f = _scalar_band(bundles, "av_hidden_nodes", "Hidden nodes")
        if f: col2.plotly_chart(styled(f, "Avg NN hidden nodes"), use_container_width=True)


# ── Compare envs view — side-by-side env summary ───────────────────────────
def render_compare_envs(envs):
    if not envs:
        st.warning("No environments detected.")
        return
    chosen = st.multiselect("Environments to compare", list(envs.keys()),
                            default=list(envs.keys()))
    if len(chosen) < 1:
        st.info("Pick at least one environment.")
        return

    paths = tuple(p for env in chosen for p in envs[env])
    df = scan_paths(paths, tuple(_file_sig(p) for p in paths))
    if df.empty:
        st.warning("No readable summaries.")
        return

    st.subheader(f"Compare environments — {len(chosen)} env, {len(df)} runs")

    agg = (df.groupby("env")
             .agg(seeds=("seed", "count"),
                  survived=("survived", "sum"),
                  extinct=("survived", lambda s: int((~s).sum())),
                  median_extinction=("extinction_tick", "median"),
                  mean_final_pop=("final_population", "mean"),
                  std_final_pop=("final_population", "std"),
                  mean_final_species=("final_species", "mean"),
                  std_final_species=("final_species", "std"))
             .reset_index())
    st.markdown("**Per-environment summary**")
    st.dataframe(agg.style.format({
        "median_extinction": "{:,.0f}",
        "mean_final_pop":    "{:,.1f}",
        "std_final_pop":     "{:,.1f}",
        "mean_final_species": "{:,.1f}",
        "std_final_species":  "{:,.1f}",
    }), use_container_width=True, hide_index=True)

    col1, col2 = st.columns(2)
    fig = px.box(df, x="env", y="final_population", points="all", color="env",
                 hover_data=["seed", "file"],
                 labels={"env": "Environment", "final_population": "Final population"})
    fig.update_layout(showlegend=False)
    col1.plotly_chart(styled(fig, "Final population per environment"),
                      use_container_width=True)
    fig = px.box(df, x="env", y="final_species", points="all", color="env",
                 hover_data=["seed", "file"],
                 labels={"env": "Environment", "final_species": "Final species"})
    fig.update_layout(showlegend=False)
    col2.plotly_chart(styled(fig, "Final species richness per environment"),
                      use_container_width=True)

    ext = df.loc[~df["survived"]].dropna(subset=["extinction_tick"])
    if not ext.empty:
        fig = px.strip(ext, x="env", y="extinction_tick", color="env",
                       hover_data=["seed", "file"],
                       labels={"env": "Environment", "extinction_tick": "Extinction tick"})
        fig.update_layout(showlegend=False)
        st.plotly_chart(styled(fig, "Extinction times per environment"),
                        use_container_width=True)
    else:
        st.info("No extinctions across the selected runs.")

    # ── Specialisation outcome (end-of-run diet stats) ────────────────────
    st.divider()
    st.markdown("### Specialisation outcome at end of run")
    st.caption(
        "These metrics answer the research question directly: **under which "
        "map regimes do organisms specialise vs generalise?** Computed from "
        "each seed's final-tick diet composition."
    )

    rows = []
    with st.spinner("Reading end-of-run diet composition…"):
        for _, row in df.iterrows():
            stats = final_diet_stats(row["path"], sig=_file_sig(row["path"]))
            if not stats:
                continue
            rows.append({
                "env":  row["env"],
                "seed": row["seed"],
                "file": row["file"],
                "Generalist (%)":            stats["generalist_pct"],
                "Specialist (%)":            stats["specialist_pct"],
                "Dominant specialist (%)":   stats["dominant_specialist_pct"],
                "Dominant diet":             stats["dominant_diet"],
                "total":                     stats["total"],
            })
    diet_df = pd.DataFrame(rows)
    if diet_df.empty:
        st.info("No usable end-of-run diet data across these runs.")
        return

    col1, col2, col3 = st.columns(3)
    fig = px.box(diet_df, x="env", y="Generalist (%)", points="all", color="env",
                 hover_data=["seed", "file"],
                 labels={"env": "Environment"})
    fig.update_layout(showlegend=False, yaxis=dict(range=[0, 100]))
    col1.plotly_chart(styled(fig, "Final generalist share"),
                      use_container_width=True)
    fig = px.box(diet_df, x="env", y="Specialist (%)", points="all", color="env",
                 hover_data=["seed", "file"],
                 labels={"env": "Environment"})
    fig.update_layout(showlegend=False, yaxis=dict(range=[0, 100]))
    col2.plotly_chart(styled(fig, "Final specialist share"),
                      use_container_width=True)
    fig = px.box(diet_df, x="env", y="Dominant specialist (%)", points="all", color="env",
                 hover_data=["seed", "file"],
                 labels={"env": "Environment"})
    fig.update_layout(showlegend=False, yaxis=dict(range=[0, 100]))
    col3.plotly_chart(styled(fig, "Largest single specialist diet"),
                      use_container_width=True)

    # Stacked bar: mean diet composition per env (stacked to 100% — it has to
    # sum, so a 100%-stack is the right encoding here even though we use lines
    # everywhere else)
    diet_long = []
    for env_name, grp in diet_df.groupby("env"):
        for cat in ("Generalist (%)", "Specialist (%)"):
            diet_long.append({"env": env_name, "category": cat.replace(" (%)", ""),
                              "mean_pct": grp[cat].mean()})
    bar_df = pd.DataFrame(diet_long)
    fig = px.bar(bar_df, x="env", y="mean_pct", color="category",
                 color_discrete_map={"Generalist": DIET_COLOURS[GEN_LABEL],
                                     "Specialist": "#1f77ff"},
                 labels={"env": "Environment", "mean_pct": "Mean % of population",
                         "category": "Diet group"},
                 barmode="stack")
    fig.update_layout(yaxis=dict(range=[0, 100]))
    st.plotly_chart(styled(fig, "Mean end-of-run generalist vs specialist split, per env"),
                    use_container_width=True)

    # Dominant diet — which specialist won per run? Count per env.
    dom = (diet_df.groupby(["env", "Dominant diet"]).size()
                  .reset_index(name="count"))
    fig = px.bar(dom, x="env", y="count", color="Dominant diet",
                 color_discrete_map=DIET_COLOURS,
                 category_orders={"Dominant diet": DIET_ORDER},
                 labels={"env": "Environment", "count": "Seeds (runs)",
                         "Dominant diet": "Which diet 'won'"},
                 barmode="stack")
    st.plotly_chart(styled(fig, "Which diet ended up dominant — count of seeds per env"),
                    use_container_width=True)

    st.markdown("**Per-seed end-of-run diet composition**")
    st.dataframe(diet_df.sort_values(["env", "seed"]).style.format({
        "Generalist (%)":          "{:,.1f}",
        "Specialist (%)":          "{:,.1f}",
        "Dominant specialist (%)": "{:,.1f}",
        "total":                   "{:,.0f}",
    }), use_container_width=True, hide_index=True)


# ── Overlay view ───────────────────────────────────────────────────────────
DIET_SHARE_PREFIX     = "Diet share (% pop): "
DIET_COUNT_PREFIX     = "Population with diet: "
SPECIES_DIET_PREFIX   = "Number of species with diet: "
SPECIALISATION_GROUP  = [
    "Generalist share (% pop)",
    "Specialist share (% pop)",
    "Dominant specialist (% pop)",
    "Specialist Shannon H",
]
_SPEC_COMPOSITE_KEYS = {
    "Generalist share (% pop)":      "Generalist (%)",
    "Specialist share (% pop)":      "Specialist (%)",
    "Dominant specialist (% pop)":   "Dominant specialist (%)",
    "Specialist Shannon H":          "Specialist Shannon H",
}
_INV_SCALAR = {v: k for k, v in SCALAR_LABELS.items()}


def overlay_series(b, choice):
    sdf = b["scalars"]
    seed_label = f"{b['name']} (seed {b['meta'].get('seed')})"
    if choice in _INV_SCALAR:
        key = _INV_SCALAR[choice]
        if key not in sdf.columns:
            return None
        out = sdf[["tick", key]].rename(columns={key: "value"})
    elif choice in _SPEC_COMPOSITE_KEYS:
        comp = b.get("diet_composite_pop")
        col  = _SPEC_COMPOSITE_KEYS[choice]
        if comp is None or comp.empty or col not in comp.columns:
            return None
        out = comp[["tick", col]].rename(columns={col: "value"})
    elif choice.startswith(DIET_SHARE_PREFIX):
        cat = choice[len(DIET_SHARE_PREFIX):]
        dd = b["diet_pop"]
        if dd.empty:
            return None
        tot = dd.groupby("tick")["value"].sum()
        sub = dd[dd["category"] == cat].set_index("tick")["value"]
        out = (sub / tot.replace(0, np.nan)).dropna().mul(100).rename("value").reset_index()
    elif choice.startswith(DIET_COUNT_PREFIX):
        cat = choice[len(DIET_COUNT_PREFIX):]
        dd = b["diet_pop"]
        if dd.empty:
            return None
        sub = dd[dd["category"] == cat]
        if sub.empty:
            return None
        out = sub[["tick", "value"]].copy()
    elif choice.startswith(SPECIES_DIET_PREFIX):
        cat = choice[len(SPECIES_DIET_PREFIX):]
        dd = b["diet_species"]
        if dd.empty:
            return None
        sub = dd[dd["category"] == cat]
        if sub.empty:
            return None
        out = sub[["tick", "value"]].copy()
    else:
        return None
    out = out.copy()
    out["seed"] = seed_label
    return out


def render_overlay(envs, flat):
    all_files = []
    for env, paths in envs.items():
        all_files.extend(paths)
    for p in flat:
        if p not in all_files:
            all_files.append(p)
    if not all_files:
        st.warning("No JSON seed files found.")
        return
    st.subheader("Overlay runs")
    chosen = st.multiselect(
        "Runs to overlay", all_files,
        default=all_files[:min(3, len(all_files))],
        format_func=lambda p: f"{os.path.basename(os.path.dirname(p))}/{os.path.basename(p)}")
    metric_groups = {
        "Specialisation (composite)": SPECIALISATION_GROUP,
        "Diet share — % of population": [DIET_SHARE_PREFIX + d for d in DIET_ORDER],
        "Diet — population count":     [DIET_COUNT_PREFIX + d for d in DIET_ORDER],
        "Diet — number of species":    [SPECIES_DIET_PREFIX + d for d in DIET_ORDER],
        "Engine scalars":              list(SCALAR_LABELS.values()),
    }
    group = st.radio("Metric group", list(metric_groups.keys()),
                     horizontal=True, key="overlay_group")
    metric = st.selectbox("Metric", metric_groups[group])
    logx = st.checkbox("Log tick axis (helps when run lengths differ a lot)")
    if not chosen:
        st.info("Pick one or more runs above.")
        return

    frames = []
    for fp in chosen:
        b = prepare(path=fp, name=f"{os.path.basename(os.path.dirname(fp))}/{os.path.basename(fp)}",
                    sig=_file_sig(fp))
        s = overlay_series(b, metric)
        if s is not None and not s.empty:
            frames.append(s)
    if not frames:
        st.info("No data for that metric in the selected runs.")
        return

    df = pd.concat(frames, ignore_index=True)
    if metric.startswith(DIET_SHARE_PREFIX):
        ylab = "% of population"
    elif metric.startswith(DIET_COUNT_PREFIX):
        ylab = "Organisms with this diet"
    elif metric.startswith(SPECIES_DIET_PREFIX):
        ylab = "Number of species"
    else:
        ylab = metric
    fig = px.line(df, x="tick", y="value", color="seed",
                  labels={"tick": "Tick", "value": ylab, "seed": "Run"})
    fig.update_traces(line_width=1.8)
    if logx:
        fig.update_xaxes(type="log")
    st.plotly_chart(styled(fig, f"{metric} — {len(chosen)} runs overlaid"),
                    use_container_width=True)
    st.caption(
        f"Tip: double-click a run in the legend to isolate it; single-click "
        f"to toggle. Each series is decimated to ~{TARGET_POINTS:,} points.")


# ── Meat-nutrition sweep view ──────────────────────────────────────────────
# Envs produced by scripts/generate_meat_sweep.py are named
# ..._predation_meat<NNN>, where NNN = meat_nutrition * 100 (e.g. meat075 = 0.75).
MEAT_ENV_RE = re.compile(r"_meat(\d+)$")
EXPLODE_POP = 3000     # max pop above this flags the runaway recycling loop


def _killer_share_over_time(b):
    """Series indexed by tick: killer cells as % of the average anatomy.
    (b["cells"] is the av_cell_counts long frame restricted to CELL_TYPES.)"""
    cdf = b["cells"]
    if cdf is None or cdf.empty:
        return None
    piv = (cdf.pivot_table(index="tick", columns="category", values="value", aggfunc="last")
              .fillna(0))
    total = piv.sum(axis=1).replace(0, np.nan)
    killer = piv["killer"] if "killer" in piv.columns else pd.Series(0.0, index=piv.index)
    return (killer / total * 100).rename("killer_pct")


def _meat_pop_fraction(b):
    """% of the final standing population whose species diet includes meat (type 0)."""
    tbl = b["species_tbl"]
    if tbl is None or tbl.empty or "final_pop" not in tbl.columns:
        return None
    pop = tbl["final_pop"].fillna(0)
    total = pop.sum()
    if not total:
        return 0.0
    eats_meat = tbl["diet"].apply(lambda d: isinstance(d, list) and 0 in d)
    return float(pop[eats_meat].sum() / total * 100)


def render_meat_sweep(envs):
    meat_envs = {e: int(m.group(1)) / 100.0
                 for e in envs if (m := MEAT_ENV_RE.search(e))}
    if not meat_envs:
        st.warning("No meat-sweep environments found. Expected "
                   "`results/..._meat<NNN>/seed_*.json` — generate them with "
                   "`scripts/generate_meat_sweep.py` and run the sweep first.")
        return

    st.subheader(f"Meat-nutrition sweep — {len(meat_envs)} meat value(s)")
    st.caption(
        "Sweeps `foodTypes[0].nutrition` (meat) on a predation map to locate where "
        "**predators/scavengers emerge** and where the death→scavenge recycling loop tips "
        "into **runaway growth**. Reproduction costs 1 food/cell and a corpse returns "
        "`cells × meat`, so meat > **1.0** is energy-positive — expect the population to "
        "blow up above the break-even line. **Predator signal** = killer-cell share of "
        "anatomy (founders start with none); **scavenger signal** = share of the final "
        "population whose species diet includes meat (type 0).")

    thr_pct = st.slider("Predator threshold — killer-cell % of anatomy", 1, 25, 5,
                        help="A meat value counts as 'has predators' when the mean "
                             "killer-cell share reaches this; emergence tick is the first "
                             "time it is crossed.")

    rows, ts = [], []
    for env, meat in sorted(meat_envs.items(), key=lambda kv: kv[1]):
        for fp in envs[env]:
            b = prepare(path=fp, name=os.path.basename(fp), sig=_file_sig(fp))
            ks = _killer_share_over_time(b)
            if ks is not None and len(ks):
                tail = max(1, len(ks) // 10)
                final_killer = float(ks.iloc[-tail:].mean())
                over = ks[ks >= thr_pct]
                emergence = int(over.index[0]) if len(over) else None
            else:
                final_killer, emergence = 0.0, None
            sdf = b["scalars"]
            max_pop = int(sdf["pop_counts"].max()) if "pop_counts" in sdf.columns else 0
            rows.append({
                "meat": meat, "seed": b["meta"].get("seed"),
                "final_killer_pct": final_killer,
                "emergence_tick": emergence,
                "max_pop": max_pop,
                "meat_diet_pct": _meat_pop_fraction(b) or 0.0,
                "exploded": max_pop >= EXPLODE_POP,
            })
            if ks is not None and len(ks):
                tf = ks.reset_index(); tf.columns = ["tick", "killer_pct"]
                tf["meat"] = meat
                ts.append(tf)

    if not rows:
        st.info("No completed seed results in the meat-sweep folders yet.")
        return
    df = pd.DataFrame(rows)
    agg = (df.groupby("meat")
             .agg(seeds=("seed", "count"),
                  final_killer_pct=("final_killer_pct", "mean"),
                  meat_diet_pct=("meat_diet_pct", "mean"),
                  emergence_tick=("emergence_tick", "mean"),
                  max_pop=("max_pop", "mean"),
                  exploded=("exploded", "sum"))
             .reset_index())

    # Chart A — predator / scavenger emergence vs meat value
    figA = go.Figure()
    figA.add_trace(go.Scatter(x=agg["meat"], y=agg["final_killer_pct"], mode="lines+markers",
                              name="Predators (killer-cell %)",
                              line=dict(color="#F2317A", width=2.4)))
    figA.add_trace(go.Scatter(x=agg["meat"], y=agg["meat_diet_pct"], mode="lines+markers",
                              name="Scavengers (pop eating meat %)",
                              line=dict(color="#1f77ff", width=2.4, dash="dash")))
    figA.add_vline(x=1.0, line=dict(color="grey", dash="dot"),
                   annotation_text="energy break-even", annotation_position="top")
    figA.update_layout(xaxis_title="Meat nutrition", yaxis_title="% (mean across seeds)")

    # Chart B — runaway onset (max population)
    figB = go.Figure()
    figB.add_trace(go.Scatter(x=agg["meat"], y=agg["max_pop"], mode="lines+markers",
                              name="Max population", line=dict(color="#4e79a7", width=2.4)))
    figB.add_vline(x=1.0, line=dict(color="grey", dash="dot"))
    figB.add_hline(y=EXPLODE_POP, line=dict(color="crimson", dash="dot"),
                   annotation_text="runaway", annotation_position="top left")
    figB.update_layout(xaxis_title="Meat nutrition", yaxis_title="Max population (mean)")

    c1, c2 = st.columns(2)
    c1.plotly_chart(styled(figA, "Predator / scavenger emergence vs meat value"),
                    use_container_width=True)
    c2.plotly_chart(styled(figB, "Runaway onset — max population vs meat value"),
                    use_container_width=True)

    # Chart C — killer-cell share over time, one line per meat value (mean across seeds)
    if ts:
        big = pd.concat(ts, ignore_index=True)
        mean_ts = big.groupby(["meat", "tick"], as_index=False)["killer_pct"].mean()
        mean_ts["meat"] = mean_ts["meat"].map(lambda v: f"{v:.2f}")
        figC = px.line(mean_ts, x="tick", y="killer_pct", color="meat",
                       labels={"tick": "Tick", "killer_pct": "Killer-cell % of anatomy",
                               "meat": "Meat"})
        figC.update_traces(line_width=1.8)
        st.plotly_chart(styled(figC, "When predators emerge — killer-cell share over time, by meat value"),
                        use_container_width=True)

    st.markdown("**Per-meat-value summary (mean across seeds)**")
    show = agg.copy()
    show["predators?"] = np.where(show["final_killer_pct"] >= thr_pct, "yes", "no")
    show["exploded"] = show["exploded"].astype(int).astype(str) + "/" + show["seeds"].astype(str)
    show = show[["meat", "seeds", "predators?", "emergence_tick", "final_killer_pct",
                 "meat_diet_pct", "max_pop", "exploded"]]
    st.dataframe(show.style.format({
        "meat": "{:.2f}", "final_killer_pct": "{:.1f}", "meat_diet_pct": "{:.1f}",
        "emergence_tick": "{:,.0f}", "max_pop": "{:,.0f}",
    }), use_container_width=True, hide_index=True)


# ═══════════════════════════════════════════════════════════════════════════
# Multi-environment sweep views (diet penalty, random-environment morphology)
# ═══════════════════════════════════════════════════════════════════════════
# These two pages summarise a whole sweep at once — 10 environments x 5 seeds
# for the diet penalty, 36 x 5 for the random environments. They therefore must
# NOT go through prepare(): that parses a full 145 MB seed into ~400 MB of
# Python objects, which is fine for one file and fatal for 180.
#
# Instead every seed is reduced to a few dozen numbers by sweep_seed_stats(),
# which streams the file with ijson and only materialises the small sub-trees it
# actually needs:
#   fossil_record.window_records  — the trailing snapshot window; all the
#                                   morphology/brain series we tail-average
#   fossil_record.species         — final standing population + mouth_diets
# Peak memory is a few MB per file instead of 400, and the result is cached to
# disk, so a results folder is paid for once rather than once per session.
#
# The definitions here deliberately mirror scripts/analyze_diet_sweep.py and
# scripts/analyze_random_sweep.py so the dashboard and the CLI report the same
# numbers.

MEAT_TYPE = 0
TAIL_FRAC = 0.10          # "settled value" = mean over the last 10% of samples

# Arms: CVD-validated pair (protan/deutan/tritan dE >= 21), same as the scripts.
ARM_COLOR = {"normal": "#0072B2", "predation": "#D55E00"}
ARM_DASH  = {"normal": "solid",   "predation": "dash"}
# Ordered factors get sequential single-hue ramps — magnitude, not category.
SCARCITY_RAMP = ["#9dc3e6", "#3d7ebf", "#12436d"]
PENALTY_RAMP  = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"]

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Env naming conventions, straight from the generators.
DIET_ENV_RE = re.compile(r"_dietp(\d+)(?:a(\d+))?$")                       # generate_diet_sweep.py
RAND_ENV_RE = re.compile(r"^rand_(\d+)_r(\d+)_e(\d+)(?:_n(\d+))?(_predation)?$")  # generate_random_maps.js

# Series we tail-average out of window_records.
WIN_KEYS = ("tick_record", "pop_counts", "species_counts", "av_cells",
            "av_cell_counts", "av_connections", "av_hidden_nodes")


def _tail_mean(series, frac=TAIL_FRAC):
    vals = [v for v in series if isinstance(v, (int, float))]
    if not vals:
        return None
    n = max(1, int(len(vals) * frac))
    return sum(vals[-n:]) / n


def _cell_mix(counts_series, frac=TAIL_FRAC):
    """Tail-averaged av_cell_counts -> (richness, entropy_bits, shares).

    Entropy is the point: a body of four mouths and a body of
    mouth+mover+eye+killer have the same cell count but are not equally
    complex, and only the composition distinguishes them."""
    dicts = [c for c in counts_series if isinstance(c, dict) and c]
    if not dicts:
        return None, None, {}
    n = max(1, int(len(dicts) * frac))
    acc = defaultdict(float)
    for d in dicts[-n:]:
        for k, v in d.items():
            if isinstance(v, (int, float)):
                acc[k] += v / n
    total = sum(acc.values())
    if total <= 0:
        return 0, 0.0, {}
    shares   = {k: v / total for k, v in acc.items()}
    richness = sum(1 for v in acc.values() if v >= 0.05)   # types in a typical body
    entropy  = -sum(p * math.log2(p) for p in shares.values() if p > 0)
    return richness, entropy, shares


def _pick(path, prefix):
    """First value at `prefix`, streamed. Returning from inside the `with` tears
    the parser down, so a prefix early in the file costs only the bytes up to
    it — `records.tick_record` is nearly free, `species` reads the whole file."""
    with open(path, "rb") as f:
        for v in ijson.items(f, prefix, use_float=True):
            return v
    return None


def _reduce_seed(summary, win, species):
    """The shared reduction: one seed -> a flat dict of scalars."""
    richness, entropy, shares = _cell_mix(win.get("av_cell_counts") or [])

    live  = [s for s in (species or {}).values() if (s.get("population") or 0) > 0]
    total = sum(s["population"] for s in live)

    plant_breadth = total_breadth = specialists = meat_pop = 0.0
    breadth_pop = defaultdict(float)
    plant_types = set()
    for s in live:
        pop    = s["population"]
        diets  = set(s.get("mouth_diets") or [])
        plants = diets - {MEAT_TYPE}
        plant_breadth += pop * len(plants)
        total_breadth += pop * max(len(diets), 1)
        specialists   += pop if len(plants) == 1 else 0
        meat_pop      += pop if MEAT_TYPE in diets else 0
        breadth_pop[len(plants)] += pop
        plant_types |= plants

    ext_tick = summary.get("extinction_tick")
    out = {
        "seed":            summary.get("seed"),
        "total_ticks":     summary.get("total_ticks"),
        "extinct":         ext_tick is not None,
        "extinction_tick": ext_tick,
        "final_pop":       summary.get("final_population") or 0,
        "final_species":   summary.get("final_species") or 0,
        "ticks_per_second": summary.get("ticks_per_second"),
        # morphology
        "av_cells":      _tail_mean(win.get("av_cells") or []),
        "cell_richness": richness,
        "cell_entropy":  entropy,
        # brain
        "connections":  _tail_mean(win.get("av_connections") or []),
        "hidden_nodes": _tail_mean(win.get("av_hidden_nodes") or []),
        # diversity
        "species_count": _tail_mean(win.get("species_counts") or []),
        "pop":           _tail_mean(win.get("pop_counts") or []),
        # diet — plant breadth EXCLUDES meat: single-cluster founders can only
        # specialise on plants, and a scavenging plant specialist would
        # otherwise be mislabelled a generalist (see analyze_diet_sweep.py).
        "plant_breadth":  (plant_breadth / total) if total else None,
        "total_breadth":  (total_breadth / total) if total else None,
        "specialist_pct": (100 * specialists / total) if total else None,
        "meat_pct":       (100 * meat_pop / total) if total else None,
        "plant_types":    sorted(plant_types),
    }
    for t in CELL_TYPES:
        out[f"{t}_pct"] = 100 * shares.get(t, 0.0)
    for n in range(4):
        out[f"breadth{n}_pct"] = (100 * breadth_pop.get(n, 0.0) / total) if total else None
    return out


@st.cache_data(show_spinner=False, persist="disk", max_entries=4000)
def sweep_seed_stats(path, sig=None):
    """One seed -> a small dict of settled metrics. Disk-persisted and keyed on
    the file's (mtime, size), so re-opening the dashboard is instant and a
    re-run seed is re-read automatically."""
    try:
        if HAVE_IJSON:
            summary = _summary_ijson(path)          # early-exits: precedes fossil_record
            win     = _pick(path, "fossil_record.window_records") or {}
            if not win:   # pre-window_records files: pull the arrays individually
                win = {k: (_pick(path, f"fossil_record.records.{k}") or [])
                       for k in WIN_KEYS}
            species = _pick(path, "fossil_record.species") or {}
        else:
            with open(path) as f:
                d = json.load(f)
            fr      = d.get("fossil_record", {}) or {}
            summary = {k: d.get(k) for k in SUMMARY_KEYS}
            win     = fr.get("window_records") or fr.get("records") or {}
            species = fr.get("species") or {}
        return _reduce_seed(summary, win, species)
    except Exception:
        return None


@st.cache_data(show_spinner=False, persist="disk", max_entries=4000)
def diet_timeseries(path, sig=None):
    """Honest specialisation-over-time series for one seed.

    population_diet_counts would be cheaper, but it buckets *any* 2+ type diet
    as "generalist", so a plant specialist that also scavenges meat is
    mislabelled. Joining species_populations to species_diets fixes that. Each
    snapshot is reduced to two floats as it arrives, so the full
    ~10k x N-species history never exists in memory at once."""
    try:
        if HAVE_IJSON:
            diets = _pick(path, "fossil_record.species_diets") or {}
            ticks = _pick(path, "fossil_record.records.tick_record") or []
            snaps = None
        else:
            with open(path) as f:
                d = json.load(f)
            fr    = d.get("fossil_record", {}) or {}
            diets = fr.get("species_diets") or {}
            ticks = (fr.get("records") or {}).get("tick_record") or []
            snaps = (fr.get("records") or {}).get("species_populations") or []
        if not ticks:
            return None

        plants_of = {name: set(dl or []) - {MEAT_TYPE} for name, dl in diets.items()}
        spec_pct, breadth = [], []

        def consume(snap):
            tot = sp = br = 0.0
            for name, pop in (snap or {}).items():
                if not pop:
                    continue
                k = len(plants_of.get(name, ()))
                tot += pop
                br  += pop * k
                sp  += pop if k == 1 else 0
            spec_pct.append(100 * sp / tot if tot else None)
            breadth.append(br / tot if tot else None)

        if snaps is None:
            with open(path, "rb") as f:
                for snap in ijson.items(
                        f, "fossil_record.records.species_populations.item",
                        use_float=True):
                    consume(snap)
        else:
            for snap in snaps:
                consume(snap)

        n = min(len(ticks), len(spec_pct))
        if not n:
            return None
        step = max(1, math.ceil(n / TARGET_POINTS))
        return pd.DataFrame({
            "tick":           list(ticks[:n])[::step],
            "specialist_pct": spec_pct[:n][::step],
            "plant_breadth":  breadth[:n][::step],
        })
    except Exception:
        return None


@st.cache_data(show_spinner=False)
def map_meta(subdir):
    """{map stem: _meta} for every map in maps/<subdir>. The generators record
    MEASURED landscape properties there (mean distance to food, island count,
    open regions), which make far better x-axes than the nominal settings."""
    out = {}
    d = os.path.join(REPO_ROOT, "maps", subdir)
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn)) as f:
                out[fn[:-5]] = (json.load(f) or {}).get("_meta", {}) or {}
        except Exception:
            continue
    return out


def collect_seed_stats(envs, names, label_fn):
    """-> one row per seed file, labelled with its sweep coordinates."""
    files = [(e, p) for e in names for p in envs[e]]
    if not files:
        return pd.DataFrame()
    rows = []
    prog = st.progress(0.0, text="Reading seed results…")
    for i, (env, p) in enumerate(files, 1):
        s = sweep_seed_stats(p, _file_sig(p))
        if s:
            rows.append({"env": env, "file": os.path.basename(p), "path": p,
                         **label_fn(env), **s})
        prog.progress(i / len(files), text=f"Reading seed results… {i}/{len(files)}")
    prog.empty()
    return pd.DataFrame(rows)


def aggregate_seeds(df, keys, metrics):
    """Survival over ALL seeds; every other metric over SURVIVING seeds only.

    An extinct run has no standing population to measure — averaging its zeros
    in would read as "smaller organisms" rather than "no organisms". Same
    convention as the CLI analysers, which is why the two agree."""
    # dict.fromkeys dedupes while preserving order — the caller may legitimately
    # pass the same column twice (e.g. a chart whose x-axis IS one of the facets).
    keys    = list(dict.fromkeys(k for k in keys if k in df.columns))
    metrics = [m for m in metrics if m in df.columns and m not in keys]
    base = (df.groupby(keys, as_index=False, dropna=False)
              .agg(seeds=("seed", "count"), extinct_n=("extinct", "sum")))
    base["extinct_pct"] = 100 * base["extinct_n"] / base["seeds"].replace(0, np.nan)
    surv = df[~df["extinct"]]
    if surv.empty:
        for m in metrics:
            base[m] = np.nan
            base[f"{m}_sd"] = np.nan
        return base
    spec = {}
    for m in metrics:
        spec[m] = (m, "mean")
        spec[f"{m}_sd"] = (m, "std")
    return base.merge(surv.groupby(keys, as_index=False, dropna=False).agg(**spec),
                      on=keys, how="left")


def _band_series(fig, x, y, sd, name, color, dash="solid", showlegend=True):
    """A mean line with a ±1 SD ribbon, in one colour."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    sd = np.asarray(sd, float)
    if sd.shape != y.shape:            # column absent, or a single-seed group
        sd = np.zeros_like(y)
    ok = ~np.isnan(y)
    if not ok.any():
        return
    x, y, sd = x[ok], y[ok], np.nan_to_num(sd[ok])
    c = color.lstrip("#")
    rgba = f"rgba({int(c[0:2],16)},{int(c[2:4],16)},{int(c[4:6],16)},0.15)"
    if (sd > 0).any():
        fig.add_traces([
            go.Scatter(x=x, y=y + sd, line=dict(width=0), showlegend=False,
                       hoverinfo="skip", legendgroup=name),
            go.Scatter(x=x, y=y - sd, line=dict(width=0), fill="tonexty",
                       fillcolor=rgba, showlegend=False, hoverinfo="skip",
                       legendgroup=name),
        ])
    fig.add_trace(go.Scatter(x=x, y=y, name=name, mode="lines+markers",
                             legendgroup=name, showlegend=showlegend,
                             line=dict(color=color, width=2.4, dash=dash),
                             marker=dict(size=8)))


# ── Diet-penalty sweep view ────────────────────────────────────────────────
def label_diet(env):
    m = DIET_ENV_RE.search(env)
    if not m:
        return {}
    return {"p": int(m.group(1)) / 100.0,
            "a": (int(m.group(2)) / 100.0) if m.group(2) else 1.0,
            "arm": "predation" if "_predation_" in env else "normal"}


def render_diet_sweep(envs):
    diet_envs = sorted(e for e in envs if DIET_ENV_RE.search(e))
    if not diet_envs:
        st.warning(
            "No diet-penalty environments found. Expected "
            "`results/..._dietp<NNN>/seed_*.json` (NNN = exponent × 100) — build "
            "them with `scripts/generate_diet_sweep.py` and run "
            "`scripts/submit_diet_sweep.sh`.")
        return

    st.subheader(f"Diet-penalty sweep — {len(diet_envs)} variant(s)")
    st.caption(
        "A mouth that eats **n** food types feeds at efficiency **a / nᵖ** "
        "(specialists, n=1, always feed at 1.0). Sweeping **p** on the d05 map "
        "asks how steep the cost of being a generalist has to be before "
        "specialists take over — and what that costs the population. "
        "The headline metric counts **plant** diet types only (meat excluded): "
        "founders sit on a single food cluster, so plants are the axis "
        "specialisation can act on, and a plant specialist that also scavenges "
        "would otherwise be mislabelled a generalist.")

    arms = sorted({label_diet(e).get("arm", "normal") for e in diet_envs})
    c1, c2 = st.columns([2, 3])
    pick_arms = c1.multiselect("Arms", arms, default=arms)
    show_ts = c2.checkbox(
        "Load specialisation-over-time (slower — reads the full history of each seed)",
        value=False)
    if not pick_arms:
        st.info("Select at least one arm.")
        return
    use = [e for e in diet_envs if label_diet(e).get("arm") in pick_arms]

    df = collect_seed_stats(envs, use, label_diet)
    if df.empty:
        st.info("No readable seed results in the diet-sweep folders yet.")
        return

    METRICS = ["specialist_pct", "plant_breadth", "total_breadth", "meat_pct",
               "final_pop", "final_species", "species_count", "av_cells",
               "breadth0_pct", "breadth1_pct", "breadth2_pct", "breadth3_pct"]
    agg = aggregate_seeds(df, ["arm", "p"], METRICS).sort_values(["arm", "p"])

    m = st.columns(4)
    m[0].metric("Variants with results", df["env"].nunique())
    m[1].metric("Seeds read", len(df))
    m[2].metric("Extinct seeds", f"{int(df['extinct'].sum())}/{len(df)}")
    span = agg["specialist_pct"].max() - agg["specialist_pct"].min()
    m[3].metric("Specialist swing across p",
                f"{span:.0f} pp" if pd.notna(span) else "—",
                help="Difference between the highest and lowest mean plant-specialist "
                     "share across the sweep — how much the penalty moved the outcome.")

    # A — does the penalty actually drive specialisation?
    figA = go.Figure()
    figB = go.Figure()
    for arm in pick_arms:
        sub = agg[agg["arm"] == arm].sort_values("p")
        _band_series(figA, sub["p"], sub["specialist_pct"], sub["specialist_pct_sd"],
                     arm, ARM_COLOR[arm], ARM_DASH[arm])
        _band_series(figB, sub["p"], sub["plant_breadth"], sub["plant_breadth_sd"],
                     arm, ARM_COLOR[arm], ARM_DASH[arm])
    figA.update_layout(xaxis_title="Diet-penalty exponent  p", yaxis_title="%",
                       yaxis_range=[-2, 102])
    figB.update_layout(xaxis_title="Diet-penalty exponent  p",
                       yaxis_title="Plant types per organism")
    figB.add_hline(y=1.0, line=dict(color="grey", dash="dot"),
                   annotation_text="pure specialist", annotation_position="bottom right")
    c1, c2 = st.columns(2)
    c1.plotly_chart(styled(figA, "Plant specialists — % of the final population"),
                    use_container_width=True)
    c2.plotly_chart(styled(figB, "Plant-diet breadth (population-weighted)"),
                    use_container_width=True)

    # B — what the penalty costs
    figC = go.Figure()
    figD = go.Figure()
    for arm in pick_arms:
        sub = agg[agg["arm"] == arm].sort_values("p")
        _band_series(figC, sub["p"], sub["final_pop"], sub["final_pop_sd"],
                     arm, ARM_COLOR[arm], ARM_DASH[arm])
        figD.add_trace(go.Bar(x=sub["p"], y=sub["extinct_pct"], name=arm,
                              marker_color=ARM_COLOR[arm],
                              customdata=np.stack([sub["extinct_n"], sub["seeds"]], -1),
                              hovertemplate="p=%{x}<br>%{customdata[0]}/%{customdata[1]} "
                                            "seeds extinct<extra></extra>"))
    figC.update_layout(xaxis_title="Diet-penalty exponent  p",
                       yaxis_title="Final population (surviving seeds)")
    figD.update_layout(xaxis_title="Diet-penalty exponent  p",
                       yaxis_title="Seeds extinct (%)", barmode="group",
                       yaxis_range=[0, 105], hovermode="closest")
    c1, c2 = st.columns(2)
    c1.plotly_chart(styled(figC, "Carrying capacity — the cost of a steeper penalty"),
                    use_container_width=True)
    c2.plotly_chart(styled(figD, "Extinction — recorded, not excluded"),
                    use_container_width=True)

    # C — the full breadth distribution, not just the specialist share
    bcols = [("breadth1_pct", "1 plant type (specialist)", "#08519c"),
             ("breadth2_pct", "2 plant types",             "#6baed6"),
             ("breadth3_pct", "3 plant types",             "#c6dbef"),
             ("breadth0_pct", "no plant diet (meat only / no mouth)", "#bdbdbd")]
    figE = go.Figure()
    for arm in pick_arms:
        sub = agg[agg["arm"] == arm].sort_values("p")
        for col, lab, colour in bcols:
            if col not in sub:
                continue
            figE.add_trace(go.Bar(
                x=[[arm] * len(sub), [f"{v:g}" for v in sub["p"]]], y=sub[col],
                name=lab, marker_color=colour, legendgroup=lab,
                showlegend=(arm == pick_arms[0])))
    figE.update_layout(barmode="stack", yaxis_title="% of final population",
                       xaxis_title="arm · diet-penalty exponent p")
    st.plotly_chart(styled(figE, "Where the population sits on the breadth axis"),
                    use_container_width=True)

    # D — when specialisation locks in (optional: needs the full history)
    if show_ts:
        frames = []
        files = list(df[["env", "p", "arm", "path"]].itertuples(index=False))
        prog = st.progress(0.0, text="Reading full histories…")
        for i, row in enumerate(files, 1):
            ts = diet_timeseries(row.path, _file_sig(row.path))
            if ts is not None and not ts.empty:
                ts = ts.copy()
                ts["p"], ts["arm"] = row.p, row.arm
                frames.append(ts)
            prog.progress(i / len(files), text=f"Reading full histories… {i}/{len(files)}")
        prog.empty()
        if frames:
            big = pd.concat(frames, ignore_index=True)
            for arm in pick_arms:
                a = big[big["arm"] == arm]
                if a.empty:
                    continue
                mean_ts = a.groupby(["p", "tick"], as_index=False)["specialist_pct"].mean()
                ps = sorted(mean_ts["p"].unique())
                fig = go.Figure()
                for i, pv in enumerate(ps):
                    s = mean_ts[mean_ts["p"] == pv]
                    colour = PENALTY_RAMP[min(int(i * len(PENALTY_RAMP) / max(len(ps), 1)),
                                              len(PENALTY_RAMP) - 1)]
                    fig.add_trace(go.Scatter(x=s["tick"], y=s["specialist_pct"],
                                             name=f"p = {pv:g}", mode="lines",
                                             line=dict(color=colour, width=2)))
                fig.update_layout(xaxis_title="Tick",
                                  yaxis_title="Plant specialists (% of population)",
                                  yaxis_range=[-2, 102])
                st.plotly_chart(
                    styled(fig, f"When specialisation locks in — {arm} arm "
                                f"(mean across seeds)"),
                    use_container_width=True)
        else:
            st.info("No full histories could be read for the time-series view.")

    # Table — mirrors scripts/analyze_diet_sweep.py
    st.markdown("**Per-variant summary** (survival over all seeds, everything "
                "else over surviving seeds)")
    show = agg.copy()
    show["efficiency at n=2"] = 1.0 / (2 ** show["p"])
    show["extinct"] = (show["extinct_n"].astype(int).astype(str) + "/"
                       + show["seeds"].astype(str))
    types = (df.groupby(["arm", "p"])["plant_types"]
               .apply(lambda s: "".join(str(t) for t in sorted(set().union(*s))) or "—")
               .rename("plant types").reset_index())
    show = show.merge(types, on=["arm", "p"], how="left")
    cols = ["arm", "p", "efficiency at n=2", "seeds", "extinct", "final_pop",
            "plant_breadth", "specialist_pct", "total_breadth", "meat_pct",
            "final_species", "plant types"]
    st.dataframe(
        show[[c for c in cols if c in show.columns]].style.format({
            "p": "{:.2f}", "efficiency at n=2": "{:.2f}", "final_pop": "{:,.0f}",
            "plant_breadth": "{:.2f}", "specialist_pct": "{:.1f}",
            "total_breadth": "{:.2f}", "meat_pct": "{:.1f}",
            "final_species": "{:.1f}"}, na_rep="—"),
        use_container_width=True, hide_index=True)
    st.caption(
        "`efficiency at n=2` — what a two-type generalist actually feeds at "
        "(a/nᵖ); specialists always feed at 1.0.  ·  `total_breadth` includes "
        "meat, and is the n the penalty divides by.  ·  `plant types` — which "
        "plant food types are still represented at the end.")


# ── Morphology in complex environments (random-environment sweep) ──────────
def label_rand(env):
    m = RAND_ENV_RE.match(env)
    if not m:
        return {}
    return {"scale": int(m.group(2)), "scarcity": int(m.group(3)),
            "replicate": int(m.group(4) or 1),
            "arm": "predation" if m.group(5) else "normal"}


# Measured landscape covariates recorded in each map's _meta by the generator.
X_AXES = {
    "Mean distance to food (measured)": ("mean_dist_to_food", "cells to the nearest emitter"),
    "Food supply (emitters)":           ("emitters",          "emitters on the map"),
    "Patch scale (Perlin resolution)":  ("scale",             "resolution — larger = coarser patches"),
    "Food islands":                     ("islands",           "connected food ribbons"),
    "Open regions":                     ("open_regions",      "walkable pockets the ribbons cut the map into"),
}
Y_METRICS = {
    "Body size (cells / organism)":   "av_cells",
    "Body composition entropy (bits)": "cell_entropy",
    "Cell-type richness":             "cell_richness",
    "Brain connections":              "connections",
    "Brain hidden nodes":             "hidden_nodes",
    "Species alive":                  "species_count",
    "Movers (% of body)":             "mover_pct",
    "Eyes (% of body)":               "eye_pct",
    "Killers (% of body)":            "killer_pct",
    "Final population":               "final_pop",
}


def render_morphology(envs):
    rand_envs = sorted(e for e in envs if RAND_ENV_RE.match(e))
    if not rand_envs:
        st.warning(
            "No random-environment results found. Expected "
            "`results/rand_<size>_r<res>_e<emitters>_n<rep>[_predation]/seed_*.json` "
            "— build the maps with `node scripts/generate_random_maps.js` and run "
            "`scripts/submit_random_sweep.sh`.")
        return

    st.subheader(f"Morphology in complex environments — {len(rand_envs)} landscape(s)")
    st.caption(
        "Perlin-contour landscapes crossing **patch scale** (how far apart food "
        "ribbons sit) with **food scarcity** (how many emitters exist), asking "
        "whether a harder environment builds a more complex organism. Complexity "
        "is read as body **size**, body **composition entropy** (a body of four "
        "mouths is simpler than mouth+mover+eye+killer at the same cell count) "
        "and **brain** size. The x-axis defaults to the *measured* mean distance "
        "to food recorded in each map's `_meta`, not the nominal setting.")

    meta   = map_meta("random_sweep")
    labels = {e: label_rand(e) for e in rand_envs}
    arms   = sorted({labels[e]["arm"] for e in rand_envs})
    reps   = sorted({labels[e]["replicate"] for e in rand_envs})

    c1, c2, c3, c4 = st.columns([2, 2, 1.4, 2])
    y_label = c1.selectbox("Complexity metric", list(Y_METRICS), index=0)
    x_label = c2.selectbox("Environment axis", list(X_AXES), index=0)
    pick_arms = c3.multiselect("Arms", arms, default=arms)
    pick_reps = c3.multiselect("Noise field", reps, default=reps)
    ring_envs = [e for e in envs if e.startswith("map_500_d")]
    baseline_env = c4.selectbox(
        "Baseline (ring map)", ["— none —"] + ring_envs,
        index=(ring_envs.index("map_500_d05") + 1) if "map_500_d05" in ring_envs else 0,
        help="Draws the same metric from a distance-sweep environment as a "
             "reference line — the ordered landscape the random maps are "
             "being compared against.")
    if not pick_arms or not pick_reps:
        st.info("Select at least one arm and one noise field.")
        return

    use = [e for e in rand_envs
           if labels[e]["arm"] in pick_arms and labels[e]["replicate"] in pick_reps]
    df = collect_seed_stats(envs, use, label_rand)
    if df.empty:
        st.info("No readable seed results in the random-sweep folders yet.")
        return
    # Join the measured landscape covariates.
    for key in ("mean_dist_to_food", "islands", "open_regions"):
        df[key] = df["env"].map(lambda e: (meta.get(e) or {}).get(key))
    df["emitters"] = (df["env"].map(lambda e: (meta.get(e) or {}).get("emitters_total"))
                                .fillna(df["scarcity"]))

    ykey = Y_METRICS[y_label]
    xkey, xhelp = X_AXES[x_label]
    METRICS = sorted(set(list(Y_METRICS.values()) + ["cell_entropy", "av_cells"]
                         + [f"{t}_pct" for t in CELL_TYPES]
                         + ["specialist_pct", "plant_breadth", "final_species"]))
    agg = aggregate_seeds(df, ["arm", "scale", "scarcity", xkey], METRICS)

    baseline = None
    if baseline_env != "— none —":
        bdf = collect_seed_stats(envs, [baseline_env], lambda e: {})
        if not bdf.empty:
            alive = bdf[~bdf["extinct"]]
            src = alive if not alive.empty else bdf
            baseline = {k: src[k].mean() for k in METRICS if k in src.columns}

    m = st.columns(4)
    m[0].metric("Landscapes with results", df["env"].nunique())
    m[1].metric("Seeds read", len(df))
    m[2].metric("Extinct seeds", f"{int(df['extinct'].sum())}/{len(df)}")
    if baseline and pd.notna(baseline.get(ykey)) and baseline.get(ykey):
        best = agg[ykey].max()
        m[3].metric(f"Best vs {baseline_env}",
                    f"{(best / baseline[ykey] - 1) * 100:+.0f}%" if pd.notna(best) else "—",
                    help=f"Best landscape's mean {y_label.lower()} against the "
                         f"ring-map baseline.")

    # A — the headline: complexity against a measured property of the landscape
    scarcities = sorted(agg["scarcity"].dropna().unique())
    figA = go.Figure()
    for si, sc in enumerate(scarcities):
        colour = SCARCITY_RAMP[min(si, len(SCARCITY_RAMP) - 1)]
        for arm in pick_arms:
            sub = (agg[(agg["scarcity"] == sc) & (agg["arm"] == arm)]
                   .dropna(subset=[xkey]).sort_values(xkey))
            _band_series(figA, sub[xkey], sub[ykey], sub.get(f"{ykey}_sd", pd.Series(dtype=float)),
                         f"{int(sc)} emitters · {arm}", colour, ARM_DASH[arm])
    if baseline and pd.notna(baseline.get(ykey)):
        figA.add_hline(y=baseline[ykey], line=dict(color="#666666", dash="dot"),
                       annotation_text=f"{baseline_env} baseline",
                       annotation_position="top left")
    figA.update_layout(xaxis_title=f"{x_label} — {xhelp}", yaxis_title=y_label)
    st.plotly_chart(styled(figA, f"{y_label} vs {x_label.lower()}"),
                    use_container_width=True)

    c1, c2 = st.columns(2)

    # B — the 3x3 factorial as a matrix, averaged over arms/replicates
    grid = (df[~df["extinct"]].groupby(["scale", "scarcity"], as_index=False)[ykey].mean()
            if not df[~df["extinct"]].empty else pd.DataFrame())
    if not grid.empty:
        piv = grid.pivot(index="scale", columns="scarcity", values=ykey).sort_index()
        figB = px.imshow(piv, text_auto=".2f", color_continuous_scale="Cividis",
                         aspect="auto",
                         labels=dict(x="Emitters (food supply)",
                                     y="Perlin resolution (patch scale)", color=y_label))
        figB.update_xaxes(type="category")
        figB.update_yaxes(type="category")
        c1.plotly_chart(styled(figB, f"{y_label} across the scale × scarcity grid"),
                        use_container_width=True)

    # C — brain against body: is a harder landscape moving organisms along the
    #     size axis, the brain axis, or both?
    pts = agg.dropna(subset=["av_cells", "connections"])
    if not pts.empty:
        figC = go.Figure()
        for si, sc in enumerate(scarcities):
            colour = SCARCITY_RAMP[min(si, len(SCARCITY_RAMP) - 1)]
            for arm in pick_arms:
                sub = pts[(pts["scarcity"] == sc) & (pts["arm"] == arm)]
                if sub.empty:
                    continue
                figC.add_trace(go.Scatter(
                    x=sub["av_cells"], y=sub["connections"], mode="markers",
                    name=f"{int(sc)} emitters · {arm}",
                    marker=dict(size=13, color=colour, line=dict(width=1.6, color="white"),
                                symbol="circle" if arm == "normal" else "diamond"),
                    customdata=np.stack([sub["scale"], sub["scarcity"]], -1),
                    hovertemplate="res %{customdata[0]} · %{customdata[1]} emitters"
                                  "<br>cells %{x:.2f}<br>connections %{y:.1f}<extra></extra>"))
        if baseline and pd.notna(baseline.get("av_cells")) and pd.notna(baseline.get("connections")):
            figC.add_trace(go.Scatter(
                x=[baseline["av_cells"]], y=[baseline["connections"]], mode="markers+text",
                name=baseline_env, text=[baseline_env], textposition="top center",
                marker=dict(size=15, color="#666666", symbol="x")))
        figC.update_layout(xaxis_title="Body size (cells / organism)",
                           yaxis_title="Brain connections", hovermode="closest")
        c2.plotly_chart(styled(figC, "Brain against body — which axis does the landscape move?"),
                        use_container_width=True)

    # D — composition, not just size
    share_cols = [f"{t}_pct" for t in CELL_TYPES if f"{t}_pct" in agg.columns]
    if share_cols:
        comp = (df[~df["extinct"]]
                .groupby(["scale", "scarcity"], as_index=False)[share_cols].mean())
        if not comp.empty:
            comp["cell"] = (comp["scale"].astype(int).astype(str) + " · "
                            + comp["scarcity"].astype(int).astype(str))
            figD = go.Figure()
            for t in CELL_TYPES:
                col = f"{t}_pct"
                if col not in comp:
                    continue
                figD.add_trace(go.Bar(x=comp["cell"], y=comp[col], name=t,
                                      marker_color=CELL_COLOURS[t]))
            figD.update_layout(barmode="stack", yaxis_title="% of the average body",
                               xaxis_title="patch scale · emitters")
            st.plotly_chart(
                styled(figD, "Body composition — a bigger body is not the same as a "
                             "more complex one"),
                use_container_width=True)

    # Table — mirrors scripts/analyze_random_sweep.py
    st.markdown("**Per-landscape summary** (survival over all seeds, everything "
                "else over surviving seeds)")
    tbl = aggregate_seeds(
        df, ["scale", "scarcity", "replicate", "arm"],
        ["mean_dist_to_food", "islands", "open_regions", "final_pop", "av_cells",
         "cell_richness", "cell_entropy", "connections", "hidden_nodes",
         "species_count", "mover_pct", "eye_pct", "killer_pct", "specialist_pct"])
    tbl["extinct"] = (tbl["extinct_n"].astype(int).astype(str) + "/"
                      + tbl["seeds"].astype(str))
    # Each map seeds one founder species per food type, so which types are still
    # represented says whether a whole island's lineage was lost.
    types = (df.groupby(["scale", "scarcity", "replicate", "arm"])["plant_types"]
               .apply(lambda s: "".join(str(t) for t in sorted(set().union(*s))) or "—")
               .rename("types").reset_index())
    tbl = tbl.merge(types, on=["scale", "scarcity", "replicate", "arm"], how="left")
    cols = ["scale", "scarcity", "replicate", "arm", "seeds", "extinct",
            "mean_dist_to_food", "islands", "open_regions", "final_pop", "av_cells",
            "cell_richness", "cell_entropy", "connections", "hidden_nodes",
            "species_count", "mover_pct", "eye_pct", "killer_pct", "specialist_pct",
            "types"]
    st.dataframe(
        tbl[[c for c in cols if c in tbl.columns]]
           .sort_values(["arm", "scale", "scarcity", "replicate"])
           .style.format({
               "mean_dist_to_food": "{:.1f}", "final_pop": "{:,.0f}",
               "av_cells": "{:.2f}", "cell_richness": "{:.1f}",
               "cell_entropy": "{:.2f}", "connections": "{:.1f}",
               "hidden_nodes": "{:.1f}", "species_count": "{:.1f}",
               "mover_pct": "{:.1f}", "eye_pct": "{:.1f}", "killer_pct": "{:.1f}",
               "specialist_pct": "{:.1f}"}, na_rep="—"),
        use_container_width=True, hide_index=True)
    st.caption(
        "`mean_dist_to_food`, `islands` and `open_regions` are measured off the "
        "map by the generator and read from `maps/random_sweep/<env>.json` "
        "`_meta` — they are properties of the landscape, not of the run. "
        "`cell_entropy` is the Shannon entropy of the body's cell-type mix in bits.")


# ── App shell ──────────────────────────────────────────────────────────────
st.title("🧬 Life Engine Explorer")
st.caption("Interactive viewer for headless simulation results. "
           "Looks for `results/<env>/seed_*.json` by default.")

with st.sidebar:
    st.header("Data")
    folder = st.text_input("Results folder", value=DEFAULT_FOLDER,
                           help="A directory of seed JSONs, or a directory of "
                                "subdirectories where each subdir is one environment.")
    uploaded = st.file_uploader("…or drop a single seed file", type="json")

    if st.button("🔄 Clear cache & reload", use_container_width=True,
                 help="Force a fresh parse of every file. Use this if you've "
                      "swapped folder contents on disk (e.g. renamed results1/ "
                      "to results/) and want to be certain nothing is stale."):
        st.cache_data.clear()
        st.rerun()

    envs, flat = discover_layout(folder)
    n_env_files = sum(len(v) for v in envs.values())

    if envs or flat:
        st.success(f"Found {n_env_files + len(flat)} seed file(s)"
                   + (f" across {len(envs)} env(s)" if envs else ""))
    else:
        st.warning("No seed files found at that path.")

    mode = st.radio(
        "View",
        ["Single seed", "Environment (mean ± SD)", "Overlay runs",
         "Compare envs", "Diet-penalty sweep", "Morphology (complex envs)",
         "Meat sweep", "Summary (all runs)"],
        index=0)
    st.divider()
    st.caption(
        f"Display resolution: {TARGET_POINTS:,} pts / series  ·  "
        f"Cache: {MAX_CACHED_SEEDS} seeds  ·  "
        f"`ijson` {'on' if HAVE_IJSON else 'off'}")

# Route to view
if uploaded is not None:
    render_single(prepare(raw=uploaded.getvalue(), name=uploaded.name))
elif mode == "Summary (all runs)":
    render_summary(envs, flat)
elif mode == "Environment (mean ± SD)":
    render_environment(envs)
elif mode == "Compare envs":
    render_compare_envs(envs)
elif mode == "Diet-penalty sweep":
    render_diet_sweep(envs)
elif mode == "Morphology (complex envs)":
    render_morphology(envs)
elif mode == "Meat sweep":
    render_meat_sweep(envs)
elif mode == "Overlay runs":
    render_overlay(envs, flat)
else:  # Single seed
    options = [(p, f"{os.path.basename(os.path.dirname(p))}/{os.path.basename(p)}")
               for env in envs.values() for p in env]
    options += [(p, os.path.basename(p)) for p in flat]
    if not options:
        st.info("Point the sidebar at a folder of seed files, or upload one.")
    else:
        labels = {p: lbl for p, lbl in options}
        chosen = st.sidebar.selectbox("Seed file",
                                      [p for p, _ in options],
                                      format_func=lambda p: labels[p])
        render_single(prepare(path=chosen, name=labels[chosen], sig=_file_sig(chosen)))
