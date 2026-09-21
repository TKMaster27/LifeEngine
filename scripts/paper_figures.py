"""Generate the paper's figures as vector PDFs from the reduced seed table.

The seed table is produced by the stdlib-only reducer that runs where the
results live (they are ~40 GB and never leave that machine); only its CSV
travels. Landscape covariates come from analysis/landscape_metrics.csv, which
`scripts/landscape_metrics.py` measures off the map files themselves.

    uv run scripts/paper_figures.py --seeds <seed_table.csv> --all
    uv run scripts/paper_figures.py --only fig4          # one figure

Design rules, applied to every figure here:
  - Vector PDF at final print width, 8 pt type, so nothing is resampled.
  - Food supply is an ORDERED factor, so it gets a light-to-dark single-hue
    ramp; the two arms get solid vs dashed. Both survive greyscale, which a
    categorical palette would not.
  - Every mean carries its n. Several landscapes rest on one surviving seed and
    a figure that hides that is lying by omission.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

REPO = Path(__file__).resolve().parents[1]
FIGDIR = REPO / "paper" / "figures"
LANDSCAPE_CSV = REPO / "analysis" / "landscape_metrics.csv"

# Column width of the ACM sigconf template, in inches, and the full text width.
COL_W, TEXT_W = 3.33, 7.0

SUPPLY_RAMP = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c", "#08306b"]
ARM_STYLE = {"normal": "-", "predation": "--"}
ARM_MARK = {"normal": "o", "predation": "D"}
FOOD_COLOURS = {1: "#FF69B4", 2: "#D7191C", 3: "#FDAE61"}

RAND_RE = re.compile(r"^rand_(\d+)_r(\d+)_e(\d+)(?:_n(\d+))?(_predation)?$")
RING_RE = r"^map_500_d\d+"

mpl.rcParams.update({
    "font.size": 8, "axes.labelsize": 8, "axes.titlesize": 8.5,
    "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7,
    "font.family": "sans-serif", "pdf.fonttype": 42, "ps.fonttype": 42,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.alpha": 0.25, "grid.linewidth": 0.5,
    "figure.dpi": 150, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
})


def supply_colour(level, levels):
    """Colour for one supply level, interpolated along the ramp so any number of
    levels stays separable (clamping merged the top three into one shade)."""
    levels = list(levels)
    if len(levels) <= 1:
        return SUPPLY_RAMP[-1]
    pos = levels.index(level) / (len(levels) - 1) * (len(SUPPLY_RAMP) - 1)
    lo, hi = int(math.floor(pos)), min(int(math.floor(pos)) + 1, len(SUPPLY_RAMP) - 1)
    f = pos - lo
    a = [int(SUPPLY_RAMP[lo].lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
    b = [int(SUPPLY_RAMP[hi].lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)]
    return "#%02x%02x%02x" % tuple(int(round(x + (y - x) * f)) for x, y in zip(a, b))


def save(fig, name):
    FIGDIR.mkdir(parents=True, exist_ok=True)
    out = FIGDIR / name
    fig.savefig(out)
    plt.close(fig)
    print(f"wrote {out.relative_to(REPO)}")


# ── data ────────────────────────────────────────────────────────────────────
def load_seeds(path):
    df = pd.read_csv(path)
    land = pd.read_csv(LANDSCAPE_CSV).drop_duplicates(subset="map", keep="first")
    keep = ["map", "mean_dist_to_food", "islands", "open_regions", "switch_cost",
            "emitters_total", "mean_island_spacing", "dist_to_2nd_type"]
    df = df.merge(land[keep].rename(columns={"map": "env"}), on="env", how="left")
    df["landscape_id"] = df["env"].str.replace("_predation", "", regex=False)
    if "arm" not in df.columns:
        df["arm"] = np.where(df["env"].str.contains("_predation"), "predation", "normal")
    # The ring ladder and the random sweep are two different experiments that
    # merely share a landscape axis. Tagging the family here lets every
    # within-random figure say so explicitly, instead of relying on ring rows
    # having a null `scarcity` -- which silently dropped them from the scatter
    # while still letting them steer the fit and the reported rho.
    df["family"] = np.where(df["env"].str.match(RING_RE), "ring", "random")
    df["ring_d"] = df["env"].str.extract(r"^map_500_d(\d+)")[0].astype("float")

    missing = sorted(set(df.loc[df["mean_dist_to_food"].isna(), "env"]))
    if missing:
        print(f"WARNING: no landscape metrics for {len(missing)} env(s): {missing[:4]}")
    return df


def random_only(df, who):
    """The random-family rows only, with a note when ring rows were dropped.

    Figures 3, 4, 6 and 7 measure the within-random supply gradient. Ring
    landscapes are a different design with no `scarcity` level, so pooling them
    changes what the statistic means."""
    if "family" not in df.columns:
        return df
    out = df[df["family"] == "random"]
    dropped = len(df) - len(out)
    if dropped:
        print(f"  {who}: random family only ({dropped} ring rows excluded)")
    return out


def landscape_means(df):
    """Survivors collapsed to one row per landscape -- the unit of analysis.
    Both arms share a map, so pooling them is what keeps a landscape from
    entering a correlation against its own properties twice."""
    surv = df[~df["extinct"].astype(bool)]
    num = [c for c in surv.columns if pd.api.types.is_numeric_dtype(surv[c])]
    out = surv.groupby("landscape_id", as_index=False)[num].mean()
    out["n_surv"] = surv.groupby("landscape_id").size().to_numpy()
    return out


def theil_sen(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y)
    if m.sum() < 3:
        return None
    s, i, lo, hi = stats.theilslopes(y[m], x[m])
    return {"slope": s, "intercept": i, "lo": lo, "hi": hi}


# ── Fig 1: what the system is ───────────────────────────────────────────────
CELL_COLOURS = {"mouth": "#DE3641", "producer": "#15DE59", "mover": "#60D4FF",
                "killer": "#F2317A", "armor": "#7230DB", "eye": "#E6E6E6",
                "body": "#BBBBBB"}
# Explicit glyphs: mouth and mover both start with M, so first-letter labels
# drew two different cell types as the same symbol.
CELL_GLYPH = {"mouth": "M", "producer": "P", "mover": "O", "killer": "K",
              "armor": "A", "eye": "E", "body": "B"}
DARK_TEXT = {"eye", "producer", "mover"}


def fig1_system(args):
    """Anatomy on the left, the loop that selects it on the right.

    Drawn from `founder_species_1.json` rather than by hand, so the organism in
    the figure is literally the one every run starts from and cannot drift out
    of date."""
    from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Rectangle

    founder = json.loads((REPO / "founder_species_1.json").read_text())
    cells = (founder.get("anatomy") or {}).get("cells", [])

    # Stacked, not side by side: this is a column-width float, and two panels
    # abreast at 3.3 in would push the loop's labels below 5 pt.
    fig, axes = plt.subplots(2, 1, figsize=(COL_W, 2.75),
                             gridspec_kw={"height_ratios": [1, 1.5]})

    # (a) the founder body plan, cell by cell
    ax = axes[0]
    used = []
    for c in cells:
        x, y = c["loc_col"], c["loc_row"]
        name = (c.get("state") or {}).get("name", "body")
        used.append(name)
        ax.add_patch(Rectangle((x - 0.5, y - 0.5), 1, 1, linewidth=0.8,
                               edgecolor="#333333",
                               facecolor=CELL_COLOURS.get(name, "#BBBBBB")))
        ax.text(x, y, CELL_GLYPH.get(name, "?"), ha="center", va="center",
                fontsize=7, color="#111111" if name in DARK_TEXT else "white")
    xs = [c["loc_col"] for c in cells]; ys = [c["loc_row"] for c in cells]
    ax.set_xlim(min(xs) - 4.5, max(xs) + 4.5)
    ax.set_ylim(max(ys) + 1.5, min(ys) - 1.1)
    ax.set_aspect("equal"); ax.axis("off")
    ax.set_title("(a) the founder body plan", fontsize=7, y=0.94)
    legend = "   ".join(f"{CELL_GLYPH[n]} {n}" for n in dict.fromkeys(used))
    ax.text(0.5, 0.02, legend, transform=ax.transAxes, ha="center", fontsize=5.5,
            color="#555555")

    # (b) the loop. Food enters from the emitter; the three organism steps form
    #     the cycle. No fitness function appears anywhere in it, which is the
    #     panel's whole point.
    ax = axes[1]
    nodes = {"emitter\nproduces food": (0.155, 0.50),
             "mouth eats\nadjacent food": (0.50, 0.84),
             "energy funds\nreproduction": (0.845, 0.50),
             "offspring body\nplan mutates": (0.50, 0.16)}
    for label, (x, y) in nodes.items():
        ax.add_patch(FancyBboxPatch((x - 0.145, y - 0.105), 0.29, 0.21,
                                    boxstyle="round,pad=0.008", linewidth=0.7,
                                    edgecolor="#666666", facecolor="#f4f4f4"))
        ax.text(x, y, label, ha="center", va="center", fontsize=5.8)
    flow = [("emitter\nproduces food", "mouth eats\nadjacent food", 0.10),
            ("mouth eats\nadjacent food", "energy funds\nreproduction", 0.18),
            ("energy funds\nreproduction", "offspring body\nplan mutates", 0.18),
            ("offspring body\nplan mutates", "mouth eats\nadjacent food", -0.62)]
    for a, b, rad in flow:
        ax.add_patch(FancyArrowPatch(nodes[a], nodes[b],
                                     connectionstyle=f"arc3,rad={rad}",
                                     arrowstyle="-|>", mutation_scale=6.5,
                                     shrinkA=20, shrinkB=20, linewidth=0.7,
                                     color="#666666"))
    # Kept clear of the return arrow, which sweeps through the middle.
    ax.text(0.50, 0.50, "no fitness function,\nno target morphology",
            ha="center", va="center", fontsize=5.5, style="italic", color="#aaaaaa")
    ax.set_xlim(0, 1); ax.set_ylim(0.02, 1.0); ax.axis("off")
    ax.set_title("(b) the only selection there is", fontsize=7, y=0.98)
    fig.tight_layout(h_pad=0.4)
    save(fig, "fig1-system.pdf")


# ── Fig 2: the manipulated variable ─────────────────────────────────────────
def _draw_map(ax, path, title):
    env = json.loads(path.read_text())
    meta = env.get("_meta", {}) or {}
    size = meta.get("size") or env.get("grid", {}).get("cols", 500)
    by_type = {}
    for e in env["grid"]["emitters"]:
        by_type.setdefault(e.get("t", 1), []).append((e["c"], e["r"]))
    for t, pts in sorted(by_type.items()):
        ax.scatter([c for c, _ in pts], [r for _, r in pts], s=0.9,
                   c=FOOD_COLOURS.get(t, "#999999"), linewidths=0, rasterized=True)
    if env.get("organisms"):
        ax.scatter([o["c"] for o in env["organisms"]], [o["r"] for o in env["organisms"]],
                   s=22, facecolors="none", edgecolors="#111111", linewidths=0.9)
    ax.set_xlim(0, size); ax.set_ylim(size, 0)
    ax.set_aspect("equal"); ax.set_xticks([]); ax.set_yticks([]); ax.grid(False)
    for sp in ax.spines.values():
        sp.set_visible(True); sp.set_linewidth(0.5); sp.set_color("#bbbbbb")
    ax.set_title(title, fontsize=6, pad=1.5)
    return meta


def _random_fleet():
    """(scale, supply, replicate, path) for the normal arm of every random map;
    the predation twin is the identical file, so it is not drawn twice."""
    out = []
    for p in sorted((REPO / "maps" / "random_near").glob("rand_*.json")):
        m = RAND_RE.match(p.stem)
        if m and not m.group(5):
            out.append((int(m.group(2)), int(m.group(3)), int(m.group(4) or 1), p))
    return out


def fig2_landscapes(args):
    """The random family as a supply x scale grid.

    Rows are supply and columns are patch scale, which is the way round that
    keeps the figure inside a page: four scales across the text width gives
    panels large enough to read the texture, where the transpose needed five
    rows and ran to thirteen inches. The ring family is drawn in Fig. 5, beside
    the contrast it belongs to."""
    maps = _random_fleet()
    scales = sorted({s for s, _, _, _ in maps})
    supplies = sorted({e for _, e, _, _ in maps})
    pick = {}
    for s, e, rep, p in sorted(maps, key=lambda t: t[2]):   # prefer noise field n1
        pick.setdefault((s, e), p)

    fig, axes = plt.subplots(len(supplies), len(scales), figsize=(TEXT_W, 4.75),
                             squeeze=False)
    for ri, sup in enumerate(supplies):
        for ci, scale in enumerate(scales):
            ax = axes[ri][ci]
            path = pick.get((scale, sup))
            if path is None:
                ax.axis("off"); continue
            meta = _draw_map(ax, path, "")
            ax.set_title(f"res {scale}  ·  dist {meta.get('mean_dist_to_food', '?')}  ·  "
                         f"{meta.get('islands', '?')} islands", fontsize=6, pad=1.5)
            if ci == 0:
                ax.set_ylabel(f"{sup} emitters", fontsize=7)
    handles = [plt.Line2D([], [], marker="o", ls="", ms=3.5, color=FOOD_COLOURS[t],
                          label=f"food type {t}") for t in (1, 2, 3)]
    handles.append(plt.Line2D([], [], marker="o", ls="", ms=5, markerfacecolor="none",
                              markeredgecolor="#111111", label="founders"))
    fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False,
               bbox_to_anchor=(0.5, -0.02), handletextpad=0.3, columnspacing=1.4)
    fig.tight_layout(h_pad=0.5, w_pad=0.3, rect=(0, 0.03, 1, 1))
    save(fig, "fig2-landscapes.pdf")


# ── Fig 5: the second landscape family ──────────────────────────────────────
def fig5_rings(args):
    """The ring family's geometry.

    The ladder has now run, so this panel is the geometry that Fig. 9 measures
    against. It also records that the founder-seeding confound is gone: these
    maps seed two founders on each of three clusters, one diet per cluster,
    which is exactly what the random maps do. Earlier ring maps put all six
    founders on a single cluster, and figures drawn from them show that."""
    rings = [REPO / "maps" / f"map_500_d{d:02d}.json" for d in (1, 5, 10)]
    rings = [r for r in rings if r.is_file()]
    if not rings:
        print("no ring maps found"); return
    fig, axes = plt.subplots(1, len(rings), figsize=(COL_W, 1.55), squeeze=False)
    for ax, path in zip(axes[0], rings):
        meta = _draw_map(ax, path, "")
        d = path.stem.split("_")[-1]
        ax.set_title(f"ring {d}", fontsize=6.5, pad=1.5)
    fig.tight_layout(w_pad=0.3)
    save(fig, "fig5-rings.pdf")


# ── Fig 3: the viability floor ──────────────────────────────────────────────
def fig3_survival(df, args):
    """What food supply buys: survival first, then everything downstream of it.

    Four panels on one shared x-axis of supply. The dashboard draws these per
    environment, which needs thirty rotated tick labels and is unreadable below
    full page width; binning on the manipulated variable says the same thing and
    fits a column."""
    df = random_only(df, "fig3")
    supplies = sorted(df["scarcity"].dropna().unique())
    scales = sorted(df["scale"].dropna().unique())
    surv = df[~df["extinct"].astype(bool)]
    # Full text width as a single row: the paper prints this as a figure*, and a
# 2x2 grid drawn at column width would have to be scaled up to fit, taking
# the 8 pt type with it.
    fig, axes = plt.subplots(1, 4, figsize=(TEXT_W, 2.05))

    # (a) survival with an interval and the counts behind it
    ax = axes[0]
    for i, sup in enumerate(supplies):
        sub = df[df["scarcity"] == sup]
        k, n = int((~sub["extinct"].astype(bool)).sum()), len(sub)
        lo, hi = stats.beta.ppf([0.025, 0.975], k + 0.5, n - k + 0.5)   # Jeffreys
        pct = 100 * k / n
        ax.bar(i, pct, color=supply_colour(sup, supplies), width=0.72)
        ax.errorbar(i, pct, yerr=[[pct - 100 * lo], [100 * hi - pct]], color="#333333",
                    capsize=1.8, lw=0.7)
        ax.text(i, 100 * hi + 3, f"{k}/{n}", ha="center", fontsize=5, color="#555555")
    ax.set_ylim(0, 112)
    ax.set_ylabel("Runs surviving (%)")
    ax.set_title("(a) survival", fontsize=7)

    # (b) the same split by patch scale, to show it is supply and not geometry
    ax = axes[1]
    w = 0.8 / max(len(scales), 1)
    for j, sc in enumerate(scales):
        xs, ys = [], []
        for i, sup in enumerate(supplies):
            sub = df[(df["scarcity"] == sup) & (df["scale"] == sc)]
            if sub.empty:
                continue
            xs.append(i + (j - (len(scales) - 1) / 2) * w)
            ys.append(100 * (~sub["extinct"].astype(bool)).mean())
        ax.bar(xs, ys, width=w * 0.9, label=f"{int(sc)}",
               color=plt.cm.Greys(0.3 + 0.5 * j / max(len(scales) - 1, 1)))
    ax.set_ylim(0, 112)
    ax.set_title("(b) by patch scale", fontsize=7)
    ax.legend(frameon=False, ncol=2, handlelength=0.9, columnspacing=0.6,
              fontsize=5.5, title="resolution", title_fontsize=5.5, loc="upper left")

    def spread(ax, col, label, title):
        """Per-supply distribution over surviving seeds: box for the spread,
        every seed as a point, because several cells hold very few survivors."""
        data = [surv.loc[surv["scarcity"] == sup, col].dropna().to_numpy()
                for sup in supplies]
        bp = ax.boxplot(data, positions=range(len(supplies)), widths=0.6,
                        showfliers=False, patch_artist=True,
                        medianprops=dict(color="#222222", lw=0.9),
                        whiskerprops=dict(lw=0.6), capprops=dict(lw=0.6))
        for patch, sup in zip(bp["boxes"], supplies):
            patch.set_facecolor(supply_colour(sup, supplies))
            patch.set_alpha(0.55); patch.set_linewidth(0.5)
        rng = np.random.default_rng(0)
        for i, vals in enumerate(data):
            if len(vals):
                ax.scatter(i + rng.uniform(-0.16, 0.16, len(vals)), vals, s=1.6,
                           color="#333333", alpha=0.55, linewidths=0, zorder=3)
        ax.set_ylabel(label)
        ax.set_title(title, fontsize=7)

    spread(axes[2], "final_pop", "Final population", "(c) population")
    spread(axes[3], "final_species", "Final species", "(d) species")

    for ax in axes.flat:
        ax.set_xticks(range(len(supplies)))
        ax.set_xticklabels([f"{int(s)}" for s in supplies], fontsize=6)
    for ax in axes:
        ax.set_xlabel("Food supply (emitters)", fontsize=7)
    fig.tight_layout(w_pad=1.1)
    save(fig, "fig3-survival.pdf")

    per = (df.groupby("landscape_id")
             .agg(emit=("scarcity", "first"), dist=("mean_dist_to_food", "first"),
                  surv=("extinct", lambda x: 100 * (~x.astype(bool)).mean())).reset_index())
    for x in ("emit", "dist"):
        r = stats.spearmanr(per[x], per["surv"], nan_policy="omit")
        print(f"  fig3: survival vs {x:5s} rho={r.statistic:+.2f} p={r.pvalue:.4f} n={len(per)}")
    for sup in supplies:
        sub = df[df["scarcity"] == sup]
        print(f"        {int(sup):>4} emitters: "
              f"{100*(~sub['extinct'].astype(bool)).mean():5.1f}% of {len(sub)}")


# ── Fig 4: the central figure ───────────────────────────────────────────────
def fig4_central(df, args):
    df = random_only(df, "fig4")
    lm = landscape_means(df)
    supplies = sorted(df["scarcity"].dropna().unique())
    # Column width: printed at 0.8\textwidth this was drawn at 4.6 in and scaled
    # UP to 5.6, magnifying the 8 pt type. Drawn at final size instead.
    fig, ax = plt.subplots(figsize=(COL_W, 2.55))

    fit = theil_sen(lm["mean_dist_to_food"], lm["av_cells"])
    if fit:
        xs = np.linspace(lm["mean_dist_to_food"].min(), lm["mean_dist_to_food"].max(), 50)
        ax.fill_between(xs, fit["intercept"] + fit["lo"] * xs,
                        fit["intercept"] + fit["hi"] * xs,
                        color="#999999", alpha=0.18, lw=0, zorder=1)
        ax.plot(xs, fit["intercept"] + fit["slope"] * xs, color="#444444", lw=1.2,
                zorder=2, label="Theil--Sen fit")

    # One point per LANDSCAPE, both arms pooled: the predation arm reuses the
    # same map, so keeping them apart would enter a landscape into the
    # correlation twice. That also means there is no arm to encode here --
    # `landscape_means` drops the non-numeric arm column, and filtering on a
    # column that is not there silently plotted the whole table once per pass,
    # which is what painted every point the same colour.
    for sup in supplies:
        sub = lm[lm["scarcity"] == sup].dropna(subset=["mean_dist_to_food", "av_cells"])
        if sub.empty:
            continue
        ax.scatter(sub["mean_dist_to_food"], sub["av_cells"],
                   s=8 + 2.0 * sub["n_surv"], marker="o",
                   facecolor=supply_colour(sup, supplies), edgecolor="#33333380",
                   linewidth=0.6, zorder=3)
    handles = [plt.Line2D([], [], marker="o", ls="", color=supply_colour(s, supplies),
                          markersize=5, markeredgecolor="#33333380", markeredgewidth=0.6,
                          label=f"{int(s)} emitters") for s in supplies]
    ax.legend(handles=handles, frameon=False, loc="upper right", ncol=1,
              handletextpad=0.3, borderpad=0.2)
    ax.set_xlabel("Mean distance to nearest food (cells, measured)")
    ax.set_ylabel("Body size (cells / organism)")
    ax.text(0.02, 0.03, "one point per landscape, both arms pooled; "
                       "marker size $\\propto$ surviving seeds",
            transform=ax.transAxes, fontsize=6, color="#666666")
    fig.tight_layout()
    save(fig, "fig4-central.pdf")

    r = stats.spearmanr(lm["mean_dist_to_food"], lm["av_cells"], nan_policy="omit")
    span = lm["mean_dist_to_food"].max() - lm["mean_dist_to_food"].min()
    print(f"  fig4: rho={r.statistic:+.2f} p={r.pvalue:.3f} n={len(lm)} "
          f"slope={fit['slope']:+.4f} cells/cell -> {fit['slope']*span:+.2f} cells "
          f"over the {span:.0f}-cell span (CI {fit['lo']*span:+.2f}..{fit['hi']*span:+.2f})")


# ── Fig 6: size is not complexity ───────────────────────────────────────────
def fig6_size_vs_complexity(df, args):
    df = random_only(df, "fig6")
    lm = landscape_means(df)
    supplies = sorted(df["scarcity"].dropna().unique())
    fig, axes = plt.subplots(1, 2, figsize=(COL_W, 2.4))

    ax = axes[0]
    for sup in supplies:
        sub = lm[lm["scarcity"] == sup].dropna(subset=["av_cells", "cell_entropy"])
        ax.scatter(sub["av_cells"], sub["cell_entropy"], s=14,
                   color=supply_colour(sup, supplies), edgecolor="white", linewidth=0.4)
    # No fitted line here on purpose: rho is about -0.1, so a trend line would
    # draw a relationship the statistic does not support, and the one landscape
    # at ten cells would carry it.
    ax.set_xlabel("Body size (cells)")
    ax.set_ylabel("Entropy (bits)")
    ax.set_title("(a) size vs variety", fontsize=7)

    ax = axes[1]
    d = lm.dropna(subset=["mouth_cells", "nonmouth_cells"]).sort_values("av_cells")
    idx = np.arange(len(d))
    ax.bar(idx, d["mouth_cells"], color="#DE3641", width=0.85, label="mouth")
    ax.bar(idx, d["nonmouth_cells"], bottom=d["mouth_cells"], color="#9ecae1",
           width=0.85, label="non-mouth")
    ax.set_xticks([])
    ax.set_xlabel("Landscapes by body size")
    ax.set_ylabel("Cells / organism")
    ax.legend(frameon=False, loc="upper left", handlelength=0.9, fontsize=6,
              borderpad=0.1, handletextpad=0.4)
    ax.set_title("(b) the extra cells are mouths", fontsize=7)
    fig.tight_layout(w_pad=1.1)
    save(fig, "fig6-size-vs-complexity.pdf")

    cvm = d["mouth_cells"].std() / d["mouth_cells"].mean() * 100
    cvn = d["nonmouth_cells"].std() / d["nonmouth_cells"].mean() * 100
    print(f"  fig6: mouth CV {cvm:.1f}% vs non-mouth CV {cvn:.1f}% "
          f"(ratio {cvm/cvn:.1f}x); rho(size, entropy)="
          f"{stats.spearmanr(lm['av_cells'], lm['cell_entropy'], nan_policy='omit').statistic:+.2f}")


# ── Fig 7: what bounds the null ─────────────────────────────────────────────
def fig7_bounds(df, args):
    df = random_only(df, "fig7")
    fig, axes = plt.subplots(1, 2, figsize=(COL_W, 2.3),
                             gridspec_kw={"width_ratios": [1.35, 1]})

    ax = axes[0]
    per = (df.groupby("landscape_id")
             .agg(dist=("mean_dist_to_food", "first"), n=("seed", "count"),
                  surv=("extinct", lambda s: (~s.astype(bool)).sum())).reset_index())
    ax.scatter(per["dist"], per["surv"], s=18, c=per["surv"], cmap="Greys",
               vmin=-4, edgecolor="#333333", linewidth=0.4)
    ax.axhline(0, color="#D7191C", lw=0.8, ls=":")
    ax.set_xlabel("Mean distance to food (cells)")
    ax.set_ylabel("Surviving seeds per landscape")
    ax.set_title("(a) axis coverage", fontsize=7)

    ax = axes[1]
    big = df[df.groupby("env")["seed"].transform("count") >= 20]
    pairs, labels = [], []
    for env, g in big.groupby("env"):
        a = g.loc[~g["extinct"].astype(bool), "av_cells"].dropna()
        b = g.loc[g["extinct"].astype(bool), "av_cells"].dropna()
        if len(a) >= 3 and len(b) >= 3:
            pairs.append((a.mean(), b.mean())); labels.append(env)
    if pairs:
        for i, (alive, died) in enumerate(pairs):
            ax.plot([0, 1], [died, alive], color="#999999", lw=0.7, zorder=1)
        ax.scatter([0] * len(pairs), [p[1] for p in pairs], s=16, color="#D7191C",
                   zorder=2, label="died")
        ax.scatter([1] * len(pairs), [p[0] for p in pairs], s=16, color="#08519c",
                   zorder=2, label="survived")
        ax.set_xlim(-0.35, 1.35); ax.set_xticks([0, 1])
        ax.set_xticklabels(["extinct", "survived"])
        ax.set_ylabel("Body size (cells)")
        alive_m = np.mean([p[0] for p in pairs]); died_m = np.mean([p[1] for p in pairs])
        print(f"  fig7: {len(pairs)} conditions, survivors {alive_m:.2f} vs "
              f"extinct {died_m:.2f} cells")
    else:
        ax.text(0.5, 0.5, "no condition has >=3 of each", ha="center",
                transform=ax.transAxes, fontsize=6.5, color="#888888")
        ax.axis("off")
    ax.set_title("(b) who we measure", fontsize=7)
    fig.tight_layout(w_pad=1.1)
    save(fig, "fig7-bounds.pdf")


def fig8_gallery(args):
    """The evolved body gallery: the null made visible.

    The panels are screenshots from the viewer's organism editor, one per
    extreme of the difficulty axis in each arm, captured at the same cell size
    and cropped to the same window, so the four bodies are directly comparable.
    Each is the modal body of that run's final state; `fig8_raw/panels.json`
    records which run it came from and how much of the population it is.
    """
    import matplotlib.image as mpimg

    raw = FIGDIR / "fig8_raw"
    meta = json.loads((raw / "panels.json").read_text())
    cell_px = meta["cell_px"]
    by_key = {p["key"]: p for p in meta["panels"]}
    rows = [(168, "hard_normal", "hard_predation", "hardest habitable"),
            (896, "easy_normal", "easy_predation", "easiest")]

    fig, axes = plt.subplots(2, 2, figsize=(COL_W, 2.5))
    for i, (supply, k_norm, k_pred, note) in enumerate(rows):
        for j, key in enumerate((k_norm, k_pred)):
            p, ax = by_key[key], axes[i][j]
            ax.imshow(mpimg.imread(raw / f"{key}.png"), interpolation="nearest")
            ax.set_xticks([]); ax.set_yticks([]); ax.grid(False)
            for sp in ax.spines.values():
                sp.set_linewidth(0.5); sp.set_color("#888888")
            if i == 0:
                ax.set_title("no predation" if j == 0 else "predation",
                             fontsize=7.5, pad=3)
            ax.set_xlabel(f"{p['cells']} cells, {100 * eval(p['frac']):.0f}% of pop.",
                          fontsize=6.5, labelpad=2)
        axes[i][0].set_ylabel(f"{supply} emitters\n({note})", fontsize=7,
                              labelpad=3)

    # one scale bar, on the last panel: three grid cells of the world
    ax = axes[-1][-1]
    h, w = mpimg.imread(raw / f"{rows[-1][2]}.png").shape[:2]
    x0, y = w - 1.5 - 3 * cell_px, h - 4.5
    ax.plot([x0, x0 + 3 * cell_px], [y, y], color="white", linewidth=1.1,
            solid_capstyle="butt")
    ax.text(x0 + 1.5 * cell_px, y - 2.5, "3 cells", color="white", fontsize=6,
            ha="center", va="bottom")

    # cell-type key, in the viewer's own neon palette
    key = [("mouth", "#DEB14D"), ("mover", "#60D4FF"), ("eye", "#B6C1EA"),
           ("killer", "#F82380")]
    handles = [plt.Line2D([], [], marker="s", ls="", markersize=4.5,
                          markerfacecolor=c, markeredgecolor="#888888",
                          markeredgewidth=0.4, label=n) for n, c in key]
    fig.legend(handles=handles, loc="lower center", ncol=4, frameon=False,
               fontsize=6.5, handletextpad=0.3, columnspacing=1.1,
               bbox_to_anchor=(0.55, -0.06))

    fig.subplots_adjust(wspace=0.06, hspace=0.38)
    save(fig, "fig8-gallery.pdf")


# ── Fig 9: the ring ladder ──────────────────────────────────────────────────
def fig9_ring_ladder(df, args):
    """The ring family's own gradient: what cluster spacing does.

    The ring maps hold supply constant and move the three food clusters apart,
    so `d` is the manipulated variable here -- not emitter count. That makes
    this the one place the geographic-isolation prediction is tested directly:
    if separating the clusters drives specialisation, `specialist_pct` should
    climb with d while the body plan need not change at all.

    Note the x-axis is the DESIGN variable d, not measured distance-to-food,
    which is U-shaped in d (clusters at the centre leave most of the map empty)
    and so would fold the ladder back on itself."""
    ring = df[df["family"] == "ring"].copy()
    if ring.empty:
        print("  fig9: no ring rows in this table; skipped")
        return
    ring["extinct"] = ring["extinct"].astype(bool)

    fig, axes = plt.subplots(1, 3, figsize=(TEXT_W, 2.1))
    arms = ["normal", "predation"]

    # (a) survival: the ladder's own failure gradient, with Jeffreys intervals
    ax = axes[0]
    for arm in arms:
        g = ring[ring["arm"] == arm]
        ds = sorted(g["ring_d"].dropna().unique())
        pts, los, his = [], [], []
        for d in ds:
            sub = g[g["ring_d"] == d]
            k, n = int((~sub["extinct"]).sum()), len(sub)
            lo, hi = stats.beta.ppf([0.025, 0.975], k + 0.5, n - k + 0.5)
            pts.append(100 * k / n); los.append(100 * lo); his.append(100 * hi)
        ax.fill_between(ds, los, his, color="#08519c", alpha=0.10, lw=0)
        ax.plot(ds, pts, ARM_STYLE[arm], marker=ARM_MARK[arm], color="#08519c",
                lw=1.1, ms=3, label=arm)
    ax.set_ylim(0, 105)
    ax.set_xlabel("Cluster spacing $d$")
    ax.set_ylabel("Runs surviving (%)")
    ax.set_title("(a) survival", fontsize=7)
    ax.legend(frameon=False, loc="lower right", handlelength=1.4)

    # (b) the hypothesis: does isolation buy dietary specialisation?
    ax = axes[1]
    surv = ring[~ring["extinct"]]
    for arm in arms:
        g = surv[surv["arm"] == arm]
        m = g.groupby("ring_d")["specialist_pct"].agg(["mean", "sem", "size"])
        ax.errorbar(m.index, m["mean"], yerr=m["sem"].fillna(0), fmt=ARM_MARK[arm],
                    ls=ARM_STYLE[arm], color="#D7191C", lw=1.1, ms=3, capsize=1.6,
                    elinewidth=0.7, label=arm)
    ax.set_ylim(0, 108)
    ax.set_xlabel("Cluster spacing $d$")
    ax.set_ylabel("Specialists (% of pop.)")
    ax.set_title("(b) dietary specialisation", fontsize=7)

    # (c) the body plan, on the same ladder -- the control the hypothesis needs
    ax = axes[2]
    for arm in arms:
        g = surv[surv["arm"] == arm]
        m = g.groupby("ring_d")["av_cells"].agg(["mean", "sem"])
        ax.errorbar(m.index, m["mean"], yerr=m["sem"].fillna(0), fmt=ARM_MARK[arm],
                    ls=ARM_STYLE[arm], color="#444444", lw=1.1, ms=3, capsize=1.6,
                    elinewidth=0.7, label=arm)
    ax.set_xlabel("Cluster spacing $d$")
    ax.set_ylabel("Body size (cells)")
    ax.set_title("(c) body size", fontsize=7)

    fig.tight_layout(w_pad=1.4)
    save(fig, "fig9-ring-ladder.pdf")

    for lab, col in (("specialist_pct", "specialist_pct"), ("av_cells", "av_cells")):
        r = stats.spearmanr(surv["ring_d"], surv[col], nan_policy="omit")
        print(f"  fig9: rho(d, {lab})={r.statistic:+.2f} p={r.pvalue:.4f} n={len(surv)}")
    k, n = int((~ring["extinct"]).sum()), len(ring)
    print(f"  fig9: ring survival {k}/{n} = {100*k/n:.1f}%")


FIGURES = {"fig1": fig1_system, "fig2": fig2_landscapes, "fig3": fig3_survival, "fig4": fig4_central,
           "fig5": fig5_rings, "fig6": fig6_size_vs_complexity, "fig7": fig7_bounds,
           "fig8": fig8_gallery, "fig9": fig9_ring_ladder}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seeds", type=Path, help="reduced per-seed CSV")
    ap.add_argument("--only", action="append", choices=sorted(FIGURES),
                    help="generate just these (default: all possible)")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    want = args.only or sorted(FIGURES)
    df = None
    if any(w not in ("fig1", "fig2", "fig5", "fig8") for w in want):
        if not args.seeds:
            ap.error("--seeds is required for every figure except fig2")
        df = load_seeds(args.seeds)
        print(f"{len(df)} seeds, {df['env'].nunique()} conditions, "
              f"{df['landscape_id'].nunique()} landscapes, "
              f"{int(df['extinct'].astype(bool).sum())} extinct")
    for name in want:
        FIGURES[name](args) if name in ("fig1", "fig2", "fig5", "fig8") else FIGURES[name](df, args)


if __name__ == "__main__":
    main()
