"""Plot graphs from a headless-mode results.json.

Reproduces the same charts shown in the web browser StatsPanel:
  - Population over time
  - Species count over time
  - Average mutation rate
  - Average organism size + per-cell-type breakdown
  - Diet specialisation (species)
  - Diet specialisation (population)

Usage:
    uv run scripts/analyze_results.py [results.json] [--out out_dir]
"""

import argparse
import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt

# Per-diet colours requested by the user.
DIET_COLOURS = {
    "type0_only": "#1f77ff",   # blue
    "type1_only": "#FF69B4",   # hot pink
    "type2_only": "#FF0000",   # red
    "type3_only": "#FFFF00",   # yellow
    "generalist": "#15DE59",   # green
    "none":       "#888888",   # gray
}
DIET_LABELS = {
    "type0_only": "Type 0 specialists",
    "type1_only": "Type 1 specialists",
    "type2_only": "Type 2 specialists",
    "type3_only": "Type 3 specialists",
    "generalist": "Generalists",
    "none":       "No diet/mouth",
}

# Cell-type colours roughly matching the in-app palette.
CELL_COLOURS = {
    "mouth":    "#DE3641",
    "producer": "#15DE59",
    "mover":    "#60D4FF",
    "killer":   "#F2317A",
    "armor":    "#7230DB",
    "eye":      "#FFFFFF",
}


def load_results(path: Path) -> dict:
    with path.open() as f:
        data = json.load(f)
    records = (data.get("fossil_record") or {}).get("records")
    if not records:
        sys.exit(f"{path}: no fossil_record.records found")
    return data


def _trim(records: dict) -> dict:
    """Strip duplicate trailing ticks (the JS writes the final tick twice)."""
    ticks = records["tick_record"]
    if len(ticks) >= 2 and ticks[-1] == ticks[-2]:
        n = len(ticks) - 1
        return {k: (v[:n] if isinstance(v, list) and len(v) == len(ticks) else v) for k, v in records.items()}
    return records


def plot_population(records, ax):
    ax.plot(records["tick_record"], records["pop_counts"], color="black", lw=1.5)
    ax.set_title("Population")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Number of organisms")
    ax.grid(alpha=0.3)


def plot_species(records, ax):
    ax.plot(records["tick_record"], records["species_counts"], color="black", lw=1.5)
    ax.set_title("Species")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Number of species")
    ax.grid(alpha=0.3)


def plot_mutation(records, ax):
    ax.plot(records["tick_record"], records["av_mut_rates"], color="black", lw=1.5)
    ax.set_title("Average Mutation Rate")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Avg. mutation rate")
    ax.grid(alpha=0.3)


def plot_cells(records, ax):
    ticks = records["tick_record"]
    ax.plot(ticks, records["av_cells"], color="black", lw=1.6, label="Avg. organism size")

    per_cell = records.get("av_cell_counts") or []
    if per_cell:
        names = list(per_cell[0].keys())
        for name in names:
            series = [d.get(name, 0) for d in per_cell]
            ax.plot(
                ticks, series,
                color=CELL_COLOURS.get(name, None),
                lw=1.1,
                label=f"Avg. {name} cells",
            )
    ax.set_title("Organism Size / Composition")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Avg. cells per organism")
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=0.3)


def _plot_diet(records, ax, key: str, title: str, ylabel: str):
    ticks = records["tick_record"]
    series = records.get(key) or []
    if not series:
        ax.set_title(f"{title} (no data)")
        return
    for diet_key, colour in DIET_COLOURS.items():
        ys = [d.get(diet_key, 0) for d in series]
        if max(ys) == 0:
            # skip flat-zero lines from the legend to reduce clutter
            continue
        ax.plot(ticks, ys, color=colour, lw=1.3, label=DIET_LABELS[diet_key])
    ax.set_title(title)
    ax.set_xlabel("Ticks")
    ax.set_ylabel(ylabel)
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=0.3)


def plot_diet_species(records, ax):
    _plot_diet(records, ax, "species_diet_counts",
               "Diet Specialisation (species)", "Number of extant species")


def plot_diet_population(records, ax):
    _plot_diet(records, ax, "population_diet_counts",
               "Diet Specialisation (population)", "Number of organisms")


def make_summary_figure(records, title: str):
    fig, axes = plt.subplots(3, 2, figsize=(14, 12))
    fig.suptitle(title, fontsize=14, fontweight="bold")
    plot_population(records,         axes[0, 0])
    plot_species(records,            axes[0, 1])
    plot_mutation(records,           axes[1, 0])
    plot_cells(records,              axes[1, 1])
    plot_diet_species(records,       axes[2, 0])
    plot_diet_population(records,    axes[2, 1])
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    return fig


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("results", nargs="?", default="results.json", help="Path to results.json (default: ./results.json)")
    p.add_argument("--out", default="analysis_out", help="Directory to write PNGs into (default: analysis_out)")
    p.add_argument("--show", action="store_true", help="Show the plots interactively instead of just saving")
    args = p.parse_args()

    results_path = Path(args.results)
    data = load_results(results_path)
    records = _trim((data["fossil_record"])["records"])

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    final_pop  = data.get("final_population", "?")
    final_spec = data.get("final_species", "?")
    final_tick = data.get("total_ticks", records["tick_record"][-1])
    extinct    = data.get("extinction_tick")
    status = "extinct at tick " + str(extinct) if extinct else "ran to tick " + str(final_tick)
    title = f"{results_path.name}  —  {status}  —  final pop {final_pop}, species {final_spec}"

    # one combined dashboard
    fig = make_summary_figure(records, title)
    combined_path = out_dir / "summary.png"
    fig.savefig(combined_path, dpi=130)
    print(f"[plots] wrote {combined_path}")

    # individual figures
    panels = [
        ("population.png",                plot_population),
        ("species.png",                   plot_species),
        ("mutation.png",                  plot_mutation),
        ("cells.png",                     plot_cells),
        ("diet_species.png",              plot_diet_species),
        ("diet_population.png",           plot_diet_population),
    ]
    for filename, plotter in panels:
        f, ax = plt.subplots(figsize=(8, 5))
        plotter(records, ax)
        f.tight_layout()
        path = out_dir / filename
        f.savefig(path, dpi=130)
        plt.close(f)
        print(f"[plots] wrote {path}")

    if args.show:
        plt.show()
    else:
        plt.close(fig)


if __name__ == "__main__":
    main()
