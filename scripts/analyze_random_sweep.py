"""Analyse the random-environment sweep: does a more complex environment produce
more complex organisms?

The sweep crosses PATCH SCALE (Perlin resolution: how far apart food patches sit)
with FOOD SCARCITY (total emitter count), on maps built by
`scripts/generate_random_maps.js`. For each map it reads the completed seed
results (results/<map>/seed_*.json) and pulls, per seed:

  MORPHOLOGY (the dependent variable)
    - cells per organism            `av_cells`  (tail-averaged)
    - cell-type richness            distinct cell types present in `av_cell_counts`
    - cell-type entropy             Shannon H over the cell-type mix, in bits —
                                    a body of 4 mouths is simpler than one with
                                    mouth+mover+eye+killer at the same cell count
    - per-type shares               mover / eye / killer / producer / armor %
  BRAIN
    - `av_connections`, `av_hidden_nodes`
  DIVERSITY / DIET
    - species count, population-weighted plant-diet breadth, plant-specialist %,
      which food types survive (the maps seed one species per type)
  SURVIVAL
    - extinction rate, extinction tick, final population

and joins them to the *measured* environment covariates the generator recorded in
each map's `_meta` (mean_dist_to_food, islands, open_regions, emitters_total), so
the x-axis can be a measured landscape property rather than a nominal setting.

Usage:
    uv run scripts/analyze_random_sweep.py
    uv run scripts/analyze_random_sweep.py --plot analysis/random_sweep.png
    uv run scripts/analyze_random_sweep.py --csv analysis/random_sweep.csv
    uv run scripts/analyze_random_sweep.py --baseline map_500_d05     # ring-map reference
"""
from __future__ import annotations
import argparse
import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MAPS_DIR  = REPO_ROOT / "maps"
# Every fleet of random landscapes, newest first. A sweep arrives as a new
# DIRECTORY (random_sweep -> random_near for the 20-seed sweep), and this script
# walks MAPS rather than results, so a hardcoded single directory does not just
# lose the covariates for the new landscapes -- it never reports them at all.
# Names overlap between fleets; the shared files are byte-identical, and
# `collect_maps` keeps the first copy so a landscape is reported once.
SWEEP_DIRS = (MAPS_DIR / "random_near", MAPS_DIR / "random_sweep")
RESULTS    = REPO_ROOT / "results"


def collect_maps(dirs=SWEEP_DIRS) -> list[Path]:
    """-> one map file per landscape name, across every fleet directory."""
    out, seen = [], set()
    for d in dirs:
        for p in sorted(d.glob("rand_*.json")):
            if p.stem not in seen:
                seen.add(p.stem)
                out.append(p)
    return out

MEAT_TYPE = 0
NAME_RE = re.compile(r"^rand_(\d+)_r(\d+)_e(\d+)(?:_n(\d+))?(_predation)?$")

# Two series (arms). CVD-validated pair, same as the diet sweep.
ARM_COLOR = {"normal": "#0072B2", "predation": "#D55E00"}
ARM_MARK  = {"normal": "o-", "predation": "s--"}
# Scarcity levels get a light->dark single-hue ramp (sequential = magnitude).
SCARCITY_RAMP = ["#9dc3e6", "#3d7ebf", "#12436d"]


def ramp_colour(ramp, i, n):
    """Colour i of n along `ramp`, interpolated. Clamping at the last stop --
    which is what indexing the list did -- drew every emitter level past the
    third in the SAME colour once the fleet grew from three levels to five."""
    if n <= 1:
        return ramp[-1]
    pos = (i / (n - 1)) * (len(ramp) - 1)
    lo  = max(0, min(int(pos), len(ramp) - 1))
    hi  = min(lo + 1, len(ramp) - 1)
    f   = pos - lo
    a = [int(ramp[lo].lstrip("#")[k:k + 2], 16) for k in (0, 2, 4)]
    b = [int(ramp[hi].lstrip("#")[k:k + 2], 16) for k in (0, 2, 4)]
    return "#%02x%02x%02x" % tuple(int(round(x + (y - x) * f)) for x, y in zip(a, b))


def tail_mean(series, frac=0.1):
    """Mean over the last `frac` of a series — the run's settled value."""
    vals = [v for v in series if isinstance(v, (int, float))]
    if not vals:
        return None
    n = max(1, int(len(vals) * frac))
    return sum(vals[-n:]) / n


def cell_mix(counts_series, frac=0.1):
    """Tail-averaged per-cell-type counts -> (richness, entropy_bits, shares)."""
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
    shares = {k: v / total for k, v in acc.items()}
    # richness: cell types actually present in a typical body (>= 0.05 cells)
    richness = sum(1 for v in acc.values() if v >= 0.05)
    entropy = -sum(p * math.log2(p) for p in shares.values() if p > 0)
    return richness, entropy, shares


def analyse_seed(path: Path) -> dict | None:
    try:
        with path.open() as f:
            d = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    fr = d.get("fossil_record", {}) or {}
    win = fr.get("window_records") or fr.get("records") or {}
    richness, entropy, shares = cell_mix(win.get("av_cell_counts") or [])

    species = fr.get("species", {}) or {}
    live = [s for s in species.values() if (s.get("population") or 0) > 0]
    total_pop = sum(s["population"] for s in live)

    plant_breadth = specialists = 0.0
    plant_types = set()
    for s in live:
        pop = s["population"]
        diets = set(s.get("mouth_diets") or [])
        plants = diets - {MEAT_TYPE}
        plant_breadth += pop * len(plants)
        specialists += pop if len(plants) == 1 else 0
        plant_types |= plants

    return {
        "extinct":         d.get("extinction_tick") is not None,
        "extinction_tick": d.get("extinction_tick"),
        "final_pop":       d.get("final_population") or 0,
        "final_species":   d.get("final_species") or 0,
        "ticks":           d.get("total_ticks") or 0,
        "ticks_per_second": d.get("ticks_per_second"),
        "av_cells":        tail_mean(win.get("av_cells") or []),
        "cell_richness":   richness,
        "cell_entropy":    entropy,
        "mover_pct":       100 * shares.get("mover", 0),
        "eye_pct":         100 * shares.get("eye", 0),
        "killer_pct":      100 * shares.get("killer", 0),
        "producer_pct":    100 * shares.get("producer", 0),
        "connections":     tail_mean(win.get("av_connections") or []),
        "hidden_nodes":    tail_mean(win.get("av_hidden_nodes") or []),
        "species_count":   tail_mean(win.get("species_counts") or []),
        "plant_breadth":   (plant_breadth / total_pop) if total_pop else None,
        "specialist_pct":  (100 * specialists / total_pop) if total_pop else None,
        "plant_types":     plant_types,
    }


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def fmt(v, spec="6.2f"):
    return "—".rjust(int(re.match(r"(\d+)", spec).group(1))) if v is None else format(v, spec)


def collect(map_files, label_fn):
    """-> list of row dicts, one per map variant, aggregated over its seeds."""
    rows = []
    for m in sorted(map_files):
        try:
            with m.open() as f:
                meta = (json.load(f) or {}).get("_meta", {}) or {}
        except (json.JSONDecodeError, OSError):
            meta = {}
        seed_files = sorted((RESULTS / m.stem).glob("seed_*.json"))
        stats = [s for s in (analyse_seed(p) for p in seed_files) if s]
        row = {"map": m.stem, **label_fn(m.stem), "seeds": len(stats),
               "mean_dist_to_food": meta.get("mean_dist_to_food"),
               "islands": meta.get("islands"),
               "open_regions": meta.get("open_regions"),
               "emitters": meta.get("emitters_total")}
        if stats:
            alive = [s for s in stats if not s["extinct"]] or []
            row.update({
                "extinct_n":     sum(s["extinct"] for s in stats),
                "extinct_pct":   100 * sum(s["extinct"] for s in stats) / len(stats),
                "final_pop":     mean([s["final_pop"] for s in alive]),
                "av_cells":      mean([s["av_cells"] for s in alive]),
                "cell_richness": mean([s["cell_richness"] for s in alive]),
                "cell_entropy":  mean([s["cell_entropy"] for s in alive]),
                "mover_pct":     mean([s["mover_pct"] for s in alive]),
                "eye_pct":       mean([s["eye_pct"] for s in alive]),
                "killer_pct":    mean([s["killer_pct"] for s in alive]),
                "connections":   mean([s["connections"] for s in alive]),
                "hidden_nodes":  mean([s["hidden_nodes"] for s in alive]),
                "species_count": mean([s["species_count"] for s in alive]),
                "plant_breadth": mean([s["plant_breadth"] for s in alive]),
                "specialist_pct": mean([s["specialist_pct"] for s in alive]),
                "types_surviving": "".join(str(t) for t in sorted(
                    set().union(*(s["plant_types"] for s in alive)) if alive else set())) or "—",
                "t_per_s":       mean([s["ticks_per_second"] for s in stats]),
            })
        rows.append(row)
    return rows


def label_random(stem: str) -> dict:
    m = NAME_RE.match(stem)
    if not m:
        return {"scale": None, "scarcity": None, "replicate": None, "arm": "normal"}
    return {
        "scale":     int(m.group(2)),
        "scarcity":  int(m.group(3)),
        "replicate": int(m.group(4) or 1),
        "arm":       "predation" if m.group(5) else "normal",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plot", type=Path, default=None, help="write a summary PNG here")
    ap.add_argument("--csv", type=Path, default=None, help="write the per-map table as CSV here")
    ap.add_argument("--baseline", default=None,
                    help="results/<env> to show as a reference line (e.g. map_500_d05) — "
                         "the ring-map environment the random maps are being compared against")
    args = ap.parse_args()

    maps = collect_maps()
    if not maps:
        raise SystemExit("No rand_*.json in " +
                         " or ".join(str(d.relative_to(REPO_ROOT)) for d in SWEEP_DIRS) +
                         " — run `node scripts/generate_random_maps.js` first.")

    rows = collect(maps, label_random)
    done = [r for r in rows if r["seeds"]]

    hdr = (f"{'scale':>5} {'emit':>5} {'rep':>3} {'arm':>9} {'seeds':>5} {'dist':>6} "
           f"{'isl':>4} {'ext':>6} {'pop':>6} {'cells':>6} {'rich':>5} {'H':>5} "
           f"{'conn':>6} {'hid':>5} {'spp':>5} {'mov%':>5} {'eye%':>5} {'kill%':>5} {'types':>5}")
    print(hdr)
    print("-" * len(hdr))
    for r in sorted(rows, key=lambda r: (r["arm"], r["scale"] or 0, r["scarcity"] or 0, r["replicate"] or 0)):
        if not r["seeds"]:
            print(f"{r['scale']:>5} {r['scarcity']:>5} {r['replicate']:>3} {r['arm']:>9} "
                  f"{'0':>5}  (no completed seed results yet)")
            continue
        print(f"{r['scale']:>5} {r['scarcity']:>5} {r['replicate']:>3} {r['arm']:>9} {r['seeds']:>5} "
              f"{fmt(r['mean_dist_to_food'], '6.1f')} {r['islands']:>4} "
              f"{r['extinct_n']}/{r['seeds']:<4} {fmt(r['final_pop'], '6.0f')} "
              f"{fmt(r['av_cells'], '6.2f')} {fmt(r['cell_richness'], '5.1f')} "
              f"{fmt(r['cell_entropy'], '5.2f')} {fmt(r['connections'], '6.1f')} "
              f"{fmt(r['hidden_nodes'], '5.1f')} {fmt(r['species_count'], '5.1f')} "
              f"{fmt(r['mover_pct'], '5.1f')} {fmt(r['eye_pct'], '5.1f')} "
              f"{fmt(r['killer_pct'], '5.1f')} {r.get('types_surviving', '—'):>5}")

    print("\n  dist = measured mean distance from an empty cell to the nearest emitter"
          "\n  cells/rich/H = body size, distinct cell types, Shannon entropy of the cell mix (bits)"
          "\n  conn/hid = brain connections and hidden nodes; spp = species alive"
          "\n  types = plant food types still represented (maps seed one species per type)")

    baseline = None
    if args.baseline:
        bstats = [s for s in (analyse_seed(p) for p in
                              sorted((RESULTS / args.baseline).glob("seed_*.json"))) if s]
        if bstats:
            alive = [s for s in bstats if not s["extinct"]] or bstats
            baseline = {k: mean([s[k] for s in alive]) for k in
                        ("av_cells", "cell_entropy", "connections", "species_count")}
            print(f"\nbaseline {args.baseline} ({len(bstats)} seeds): "
                  f"cells={fmt(baseline['av_cells'], '.2f')} H={fmt(baseline['cell_entropy'], '.2f')} "
                  f"conn={fmt(baseline['connections'], '.1f')} spp={fmt(baseline['species_count'], '.1f')}")
        else:
            print(f"\nbaseline {args.baseline}: no completed seed results")

    if args.csv and rows:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        keys = sorted({k for r in rows for k in r})
        with args.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {args.csv}")

    if args.plot and done:
        import matplotlib.pyplot as plt

        scarcities = sorted({r["scarcity"] for r in done})
        panels = [("av_cells",      "Body size (cells per organism)"),
                  ("cell_entropy",  "Body composition entropy (bits)"),
                  ("connections",   "Brain connections"),
                  ("species_count", "Species alive")]
        fig, axes = plt.subplots(2, 2, figsize=(11, 7.5), sharex=True)
        for ax, (key, title) in zip(axes.flat, panels):
            for si, sc in enumerate(scarcities):
                color = ramp_colour(SCARCITY_RAMP, si, len(scarcities))
                for arm in ("normal", "predation"):
                    pts = [(r["mean_dist_to_food"], r.get(key)) for r in done
                           if r["scarcity"] == sc and r["arm"] == arm and r.get(key) is not None
                           and r["mean_dist_to_food"] is not None]
                    if not pts:
                        continue
                    pts.sort()
                    ax.plot([p[0] for p in pts], [p[1] for p in pts],
                            ARM_MARK[arm], color=color, lw=2, ms=7, alpha=0.95,
                            label=f"{sc} emitters, {arm}")
            if baseline and baseline.get(key) is not None:
                ax.axhline(baseline[key], color="#666666", ls=":", lw=1.5)
                ax.text(ax.get_xlim()[1], baseline[key], f" {args.baseline} ",
                        fontsize=7, color="#666666", va="bottom", ha="right")
            ax.set_title(title, fontsize=10)
            ax.grid(alpha=0.25, lw=0.6)
            ax.set_axisbelow(True)
        for ax in axes[1]:
            ax.set_xlabel("mean distance to nearest food (cells) — measured from the map")
        axes[0][0].legend(frameon=False, fontsize=7, ncol=2)
        fig.suptitle("Random-environment sweep: does a harder landscape build more complex organisms?")
        fig.tight_layout()
        args.plot.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.plot, dpi=140)
        print(f"wrote {args.plot}")


if __name__ == "__main__":
    main()
