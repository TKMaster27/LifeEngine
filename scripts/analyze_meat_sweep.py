"""Analyse the meat-nutrition sweep: at what meat value do scavengers/predators
emerge, and where does the population tip into runaway growth?

For every meat variant (maps/meat_sweep/*.json) it reads the completed seed
result files (results/<variant>/seed_*.json) and extracts, per seed:

  - killer-cell share of anatomy over time  -> PREDATOR signal
      * emergence tick  = first snapshot where killer share >= 5%
      * final killer %  = mean over the last 10% of the run
  - fraction of recorded species whose diet includes food type 0 (meat)
      -> SCAVENGER signal
  - population trajectory (max / final) and an "exploded" flag (max pop huge)

Results are averaged across seeds and printed as a table sorted by meat value,
plus an optional summary plot.

Usage:
    uv run scripts/analyze_meat_sweep.py
    uv run scripts/analyze_meat_sweep.py --plot analysis/meat_sweep.png
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SWEEP_DIR = REPO_ROOT / "maps" / "meat_sweep"
RESULTS   = REPO_ROOT / "results"

KILLER_THRESHOLD = 0.05     # 5% of cells are killers -> "predators present"
EXPLODE_POP      = 3000     # max pop above this -> runaway recycling loop
MEAT_RE = re.compile(r"_meat(\d+)\.json$")


def killer_share(cell_dict: dict) -> float:
    if not isinstance(cell_dict, dict):
        return 0.0
    total = sum(v for v in cell_dict.values())
    return (cell_dict.get("killer", 0) / total) if total else 0.0


def analyse_seed(path: Path) -> dict | None:
    try:
        with path.open() as f:
            d = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    fr = d.get("fossil_record", {})
    r = fr.get("records", {})
    ticks = r.get("tick_record") or []
    pops  = r.get("pop_counts") or []
    accs  = r.get("av_cell_counts") or []
    if not ticks or not pops:
        return None

    shares = [killer_share(c) for c in accs]
    emergence_tick = None
    for t, s in zip(ticks, shares):
        if s >= KILLER_THRESHOLD:
            emergence_tick = t
            break
    tail = max(1, len(shares) // 10)
    final_killer = sum(shares[-tail:]) / tail if shares else 0.0

    # Scavenger signal: fraction of recorded species whose diet includes type 0.
    diets = fr.get("species_diets", {}) or {}
    n_sp = len(diets)
    n_meat = sum(1 for dl in diets.values() if isinstance(dl, list) and 0 in dl)
    frac_meat = (n_meat / n_sp) if n_sp else 0.0

    return {
        "emergence_tick": emergence_tick,
        "final_killer": final_killer,
        "max_pop": max(pops),
        "final_pop": pops[-1],
        "exploded": max(pops) >= EXPLODE_POP,
        "frac_meat_species": frac_meat,
    }


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plot", type=Path, default=None,
                    help="optional path to write a summary PNG")
    args = ap.parse_args()

    variants = sorted(SWEEP_DIR.glob("*_meat*.json"),
                      key=lambda p: int(MEAT_RE.search(p.name).group(1)))
    if not variants:
        raise SystemExit("No maps/meat_sweep/*.json — run generate_meat_sweep.py + the sweep first.")

    rows = []
    print(f"{'meat':>5} {'seeds':>5} {'predators?':>10} {'emerge@tick':>12} "
          f"{'killer%':>8} {'meat-diet%':>10} {'max_pop':>8} {'exploded':>8}")
    print("-" * 78)
    for v in variants:
        meat = int(MEAT_RE.search(v.name).group(1)) / 100.0
        seed_files = sorted((RESULTS / v.stem).glob("seed_*.json"))
        stats = [s for s in (analyse_seed(p) for p in seed_files) if s]
        if not stats:
            print(f"{meat:>5} {'0':>5}  (no completed seed results yet)")
            continue
        em = mean([s["emergence_tick"] for s in stats])
        fk = mean([s["final_killer"] for s in stats]) or 0.0
        fm = mean([s["frac_meat_species"] for s in stats]) or 0.0
        mp = mean([s["max_pop"] for s in stats]) or 0.0
        exploded = sum(s["exploded"] for s in stats)
        predators = "yes" if fk >= KILLER_THRESHOLD else "no"
        rows.append((meat, fk, fm, mp, em))
        em_s = f"{int(em):,}" if em is not None else "never"
        print(f"{meat:>5} {len(stats):>5} {predators:>10} {em_s:>12} "
              f"{100*fk:>7.1f}% {100*fm:>9.1f}% {mp:>8.0f} {exploded}/{len(stats):>3}")

    if args.plot and rows:
        import matplotlib.pyplot as plt
        rows.sort()
        xs = [r[0] for r in rows]
        fig, ax1 = plt.subplots(figsize=(7, 4.5))
        ax1.plot(xs, [100*r[1] for r in rows], "o-", color="crimson", label="final killer-cell %")
        ax1.plot(xs, [100*r[2] for r in rows], "s--", color="darkorange", label="species eating meat %")
        ax1.set_xlabel("meat nutrition"); ax1.set_ylabel("% (predator / scavenger signal)")
        ax1.axvline(1.0, color="grey", ls=":", lw=1); ax1.text(1.0, 2, " energy break-even", fontsize=8, color="grey")
        ax2 = ax1.twinx()
        ax2.plot(xs, [r[3] for r in rows], "^-", color="steelblue", label="max population")
        ax2.set_ylabel("max population", color="steelblue")
        ax1.legend(loc="upper left", fontsize=8)
        fig.suptitle("Meat-nutrition sweep: predator / scavenger emergence & runaway onset")
        fig.tight_layout()
        args.plot.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.plot, dpi=140)
        print(f"\nwrote {args.plot}")


if __name__ == "__main__":
    main()
