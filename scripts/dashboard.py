"""
Life Engine Explorer
====================
Interactive dashboard for Life Engine simulation output (one JSON per seed).

Run with:
    uv run streamlit run scripts/dashboard.py

By default it looks in ./results — the same layout the CHPC sweep produces:

    results/
    ├── map_300_close/
    │   ├── seed_1.json
    │   ├── seed_2.json
    │   └── ...
    ├── map_300_medium/
    └── ...

Four views:
    Single seed      — every chart from analyze_results.py, interactive
    Overlay runs     — overlay any chosen runs on a single metric
    Environment      — mean ± SD bands across seeds within one environment
    Compare envs     — side-by-side env summaries (extinction, richness, etc.)

Memory / performance notes (matters for full 10M-tick records, ~145 MB each):
  - Files parse to ~400 MB in RAM. We parse ONCE, extract only the compact
    series we plot, then discard the raw object. Only the small derived
    bundle (a few MB) is cached, and the cache is bounded.
  - Time series are decimated to TARGET_POINTS for display.
  - The cross-seed / cross-env summary view reads ONLY the cheap top-level
    summary fields (via ijson if installed) — never the 145 MB body.
"""

import os
import json
import glob
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
def prepare(path=None, raw=None, name=""):
    """Parse one seed and return a COMPACT bundle. The 400 MB raw dict is
    local to this function and freed on return; only the small bundle is cached."""
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
def final_diet_stats(path):
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
def _seed_files(directory):
    """List tracked-result seed files in a directory, excluding world snapshots."""
    return sorted(
        p for p in glob.glob(os.path.join(directory, "seed_*.json"))
        if not p.endswith("_world.json")
    )


def discover_layout(folder):
    """Return (envs, flat) where envs is {env_name: [paths]} based on the
    results/<env>/seed_*.json convention, and flat is the bare top-level list.
    Excludes any `seed_*_world.json` snapshots (those live under worlds/ in
    the new layout but may persist in older results trees)."""
    envs = {}
    if os.path.isdir(folder):
        for entry in sorted(os.listdir(folder)):
            sub = os.path.join(folder, entry)
            if os.path.isdir(sub):
                seeds = _seed_files(sub)
                if seeds:
                    envs[entry] = seeds
    flat = sorted(
        p for p in glob.glob(os.path.join(folder, "*.json"))
        if not p.endswith("_world.json")
    )
    return envs, flat


@st.cache_data(show_spinner="Reading summaries…")
def scan_paths(paths_tuple):
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
    df = scan_paths(tuple(paths))
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
    bundles = [prepare(path=fp, name=os.path.basename(fp)) for fp in chosen]
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
    df = scan_paths(paths)
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
            stats = final_diet_stats(row["path"])
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
        b = prepare(path=fp, name=f"{os.path.basename(os.path.dirname(fp))}/{os.path.basename(fp)}")
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
         "Compare envs", "Summary (all runs)"],
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
        render_single(prepare(path=chosen, name=labels[chosen]))
