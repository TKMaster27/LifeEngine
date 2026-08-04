"""Analyse the diet-penalty sweep: how does the diet-breadth penalty `a / n^p`
shape specialisation, and what does it cost the population?

For every variant (maps/diet_sweep/*.json) it reads the completed seed results
(results/<variant>/seed_*.json) and extracts, per seed, from the *final standing
population* (species with `population > 0`, weighted by that population):

  - plant-diet breadth        -> diet types excluding meat (type 0). This is the
                                 research signal: single-cluster founders can only
                                 specialise on plants, and meat inflates the coarse
                                 `population_diet_counts` "generalist" bucket.
  - plant-specialist share    -> % of the population with exactly one plant type
  - total diet breadth `n`    -> including meat; this is what the penalty divides by
  - meat-in-diet share        -> % of the population that also scavenges
  - survival                  -> extinct? extinction tick, final population

Seeds are aggregated per (arm, p) and printed as a table; extinction is reported,
not excluded — a steeper penalty lowers efficiency, lowers carrying capacity and
so raises extinction risk, which is itself a result.

Usage:
    uv run scripts/analyze_diet_sweep.py
    uv run scripts/analyze_diet_sweep.py --plot analysis/diet_sweep.png
    uv run scripts/analyze_diet_sweep.py --csv analysis/diet_sweep.csv
"""
from __future__ import annotations
import argparse
import csv
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SWEEP_DIR = REPO_ROOT / "maps" / "diet_sweep"
RESULTS   = REPO_ROOT / "results"

MEAT_TYPE = 0
# map_500_d05_predation_dietp150.json -> p=1.50 (optional 'aNNN' strength suffix)
DIET_RE = re.compile(r"_dietp(\d+)(?:a(\d+))?$")

# Two series, one per arm. CVD-validated pair (protan/deutan/tritan dE >= 21).
ARM_COLOR = {"normal": "#0072B2", "predation": "#D55E00"}
ARM_MARK  = {"normal": "o-", "predation": "s--"}


def analyse_seed(path: Path) -> dict | None:
    """Population-weighted diet stats for one completed seed file."""
    try:
        with path.open() as f:
            d = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None

    species = (d.get("fossil_record", {}) or {}).get("species", {}) or {}
    live = [s for s in species.values() if (s.get("population") or 0) > 0]
    total = sum(s["population"] for s in live)

    stat = {
        "extinct": d.get("extinction_tick") is not None,
        "extinction_tick": d.get("extinction_tick"),
        "final_pop": d.get("final_population") or 0,
        "final_species": d.get("final_species") or 0,
        "total_ticks": d.get("total_ticks") or 0,
        "plant_breadth": None,
        "plant_specialist_pct": None,
        "total_breadth": None,
        "meat_pct": None,
        "plant_types": set(),
    }
    if not live or not total:
        return stat                       # extinct seed: survival stats only

    plant_breadth = specialists = total_breadth = meat_pop = 0.0
    for s in live:
        pop    = s["population"]
        diets  = set(s.get("mouth_diets") or [])
        plants = diets - {MEAT_TYPE}
        plant_breadth += pop * len(plants)
        total_breadth += pop * max(len(diets), 1)
        specialists   += pop if len(plants) == 1 else 0
        meat_pop      += pop if MEAT_TYPE in diets else 0
        stat["plant_types"] |= plants

    stat["plant_breadth"]        = plant_breadth / total
    stat["total_breadth"]        = total_breadth / total
    stat["plant_specialist_pct"] = 100 * specialists / total
    stat["meat_pct"]             = 100 * meat_pop / total
    return stat


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def fmt(v, spec=".2f"):
    return "—" if v is None else format(v, spec)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plot", type=Path, default=None, help="write a summary PNG here")
    ap.add_argument("--csv", type=Path, default=None, help="write the aggregate table as CSV here")
    args = ap.parse_args()

    variants = sorted(SWEEP_DIR.glob("*_dietp*.json"))
    if not variants:
        raise SystemExit("No maps/diet_sweep/*.json — run generate_diet_sweep.py "
                         "and the sweep first.")

    rows = []
    for v in variants:
        m = DIET_RE.search(v.stem)
        if not m:
            continue
        p = int(m.group(1)) / 100.0
        a = int(m.group(2)) / 100.0 if m.group(2) else 1.0
        arm = "predation" if "_predation_" in v.name else "normal"

        seed_files = sorted((RESULTS / v.stem).glob("seed_*.json"))
        stats = [s for s in (analyse_seed(f) for f in seed_files) if s]
        if not stats:
            rows.append({"arm": arm, "p": p, "a": a, "seeds": 0})
            continue

        alive = [s for s in stats if not s["extinct"]]
        types = set().union(*(s["plant_types"] for s in stats)) if stats else set()
        rows.append({
            "arm": arm, "p": p, "a": a, "seeds": len(stats),
            "extinct_n": sum(s["extinct"] for s in stats),
            "extinct_pct": 100 * sum(s["extinct"] for s in stats) / len(stats),
            "final_pop": mean([s["final_pop"] for s in alive]),
            "final_species": mean([s["final_species"] for s in alive]),
            "plant_breadth": mean([s["plant_breadth"] for s in alive]),
            "plant_specialist_pct": mean([s["plant_specialist_pct"] for s in alive]),
            "total_breadth": mean([s["total_breadth"] for s in alive]),
            "meat_pct": mean([s["meat_pct"] for s in alive]),
            "plant_types": "".join(str(t) for t in sorted(types)) or "—",
        })

    rows.sort(key=lambda r: (r["arm"], r["p"]))

    hdr = (f"{'arm':>10} {'p':>5} {'eff n=2':>8} {'seeds':>6} {'extinct':>8} "
           f"{'final pop':>10} {'plant n':>8} {'spec %':>7} {'diet n':>7} "
           f"{'meat %':>7} {'types':>6}")
    print(hdr)
    print("-" * len(hdr))
    last_arm = None
    for r in rows:
        if last_arm and r["arm"] != last_arm:
            print()
        last_arm = r["arm"]
        if not r["seeds"]:
            print(f"{r['arm']:>10} {r['p']:>5} {r['a']/2**r['p']:>8.2f} "
                  f"{'0':>6}  (no completed seed results yet)")
            continue
        print(f"{r['arm']:>10} {r['p']:>5} {r['a']/2**r['p']:>8.2f} {r['seeds']:>6} "
              f"{r['extinct_n']}/{r['seeds']:<6} {fmt(r['final_pop'], '10.0f')} "
              f"{fmt(r['plant_breadth'], '8.2f')} {fmt(r['plant_specialist_pct'], '7.1f')} "
              f"{fmt(r['total_breadth'], '7.2f')} {fmt(r['meat_pct'], '7.1f')} "
              f"{r['plant_types']:>6}")

    print("\n  eff n=2 = generalist absorption at a 2-type diet (a/n^p); specialists always 1.0"
          "\n  plant n = population-weighted diet breadth excluding meat; spec % = share with exactly 1 plant type"
          "\n  diet n  = breadth including meat (what the penalty divides by); types = plant types present")

    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        with args.csv.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"\nwrote {args.csv}")

    if args.plot and any(r["seeds"] for r in rows):
        import matplotlib.pyplot as plt

        panels = [
            ("plant_specialist_pct", "Plant specialists (% of population)", (0, 105)),
            ("plant_breadth",        "Plant-diet breadth (mean types/organism)", None),
            ("extinct_pct",          "Seeds extinct (%)", (-5, 105)),
            ("final_pop",            "Final population (surviving seeds)", None),
        ]
        fig, axes = plt.subplots(2, 2, figsize=(10, 7), sharex=True)
        for ax, (key, label, ylim) in zip(axes.flat, panels):
            for arm in ("normal", "predation"):
                pts = [(r["p"], r.get(key)) for r in rows
                       if r["arm"] == arm and r["seeds"] and r.get(key) is not None]
                if not pts:
                    continue
                pts.sort()
                ax.plot([x for x, _ in pts], [y for _, y in pts], ARM_MARK[arm],
                        color=ARM_COLOR[arm], lw=2, ms=7, label=arm)
            ax.set_title(label, fontsize=10)
            ax.grid(alpha=0.25, lw=0.6)
            ax.set_axisbelow(True)
            if ylim:
                ax.set_ylim(*ylim)
        for ax in axes[1]:
            ax.set_xlabel("diet-penalty exponent  p   (efficiency = a / n^p)")
        axes[0][0].legend(frameon=False, fontsize=9)
        fig.suptitle("Diet-penalty sweep (d05, 500×500): specialisation vs. penalty steepness")
        fig.tight_layout()
        args.plot.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.plot, dpi=140)
        print(f"wrote {args.plot}")


if __name__ == "__main__":
    main()
