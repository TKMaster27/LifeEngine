"""Plot graphs from a headless-mode results.json.

Reproduces the same charts shown in the web browser StatsPanel:
  - Population over time
  - Species count over time
  - Average mutation rate
  - Average organism size + per-cell-type breakdown
  - Diet specialisation (species)
  - Diet specialisation (population)
  - Per-species population over time (lines coloured by diet)

Usage:
    uv run scripts/analyze_results.py [results.json] [--out out_dir]
"""

import argparse
import json
import math
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


def _diet_key(mouth_diets):
    """Map a species' mouth_diets array to one of the DIET_COLOURS keys."""
    if not mouth_diets:
        return "none"
    if len(mouth_diets) > 1:
        return "generalist"
    d = mouth_diets[0]
    if d in (0, 1, 2, 3):
        return f"type{d}_only"
    return "none"


def plot_species_populations(records, species_diets, ax):
    """One line per species (filtered to pop > 10 at the JS side), coloured by diet.

    NaN is used where a species is below the threshold so matplotlib leaves a
    gap rather than dropping the line to zero.
    """
    ticks = records["tick_record"]
    pops_by_tick = records.get("species_populations") or []
    # Tolerate null/None entries: pre-fix runs that load+continue from an
    # older save wrote `null` placeholders instead of {}.
    pops_by_tick = [s if isinstance(s, dict) else {} for s in pops_by_tick]
    if not pops_by_tick:
        ax.set_title("Species Populations (no data — older results file)")
        return
    all_names = set()
    for snap in pops_by_tick:
        all_names.update(snap.keys())
    if not all_names:
        ax.set_title("Species Populations (no species crossed pop > 10)")
        ax.set_xlabel("Ticks")
        ax.set_ylabel("Population")
        ax.grid(alpha=0.3)
        return
    legend_seen = set()
    for name in sorted(all_names):
        ys = [snap.get(name, math.nan) for snap in pops_by_tick]
        key = _diet_key(species_diets.get(name, []))
        colour = DIET_COLOURS[key]
        if key in legend_seen:
            label = None
        else:
            legend_seen.add(key)
            label = DIET_LABELS[key]
        ax.plot(ticks, ys, color=colour, lw=1.0, alpha=0.7, label=label)
    ax.set_title(f"Species Populations (pop > 10, n={len(all_names)} species)")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Population")
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=0.3)


def plot_brain_complexity(records, ax):
    """NEAT topology growth: avg enabled connections + avg hidden nodes per organism."""
    ticks = records["tick_record"]
    conns  = records.get("av_connections")
    hidden = records.get("av_hidden_nodes")
    if not conns and not hidden:
        ax.set_title("Brain Complexity (no data — pre-Phase 2 run?)")
        return
    if conns:
        ax.plot(ticks, conns, color="#1f77ff", lw=1.5, label="Avg. enabled connections")
    if hidden:
        # Different y-magnitude; use a secondary axis so both are readable.
        ax2 = ax.twinx()
        ax2.plot(ticks, hidden, color="#FF69B4", lw=1.4, label="Avg. hidden nodes")
        ax2.set_ylabel("Avg. hidden nodes", color="#FF69B4")
        ax2.tick_params(axis='y', labelcolor="#FF69B4")
    ax.set_title("Brain Complexity (NEAT topology)")
    ax.set_xlabel("Ticks")
    ax.set_ylabel("Avg. enabled connections", color="#1f77ff")
    ax.tick_params(axis='y', labelcolor="#1f77ff")
    ax.grid(alpha=0.3)


def make_summary_figure(records, species_diets, title: str):
    fig, axes = plt.subplots(4, 2, figsize=(14, 16))
    fig.suptitle(title, fontsize=14, fontweight="bold")
    plot_population(records,                       axes[0, 0])
    plot_species(records,                          axes[0, 1])
    plot_mutation(records,                         axes[1, 0])
    plot_cells(records,                            axes[1, 1])
    plot_diet_species(records,                     axes[2, 0])
    plot_diet_population(records,                  axes[2, 1])
    plot_brain_complexity(records,                 axes[3, 0])
    plot_species_populations(records, species_diets, axes[3, 1])
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
    species_diets = (data.get("fossil_record") or {}).get("species_diets") or {}

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    final_pop  = data.get("final_population", "?")
    final_spec = data.get("final_species", "?")
    final_tick = data.get("total_ticks", records["tick_record"][-1])
    extinct    = data.get("extinction_tick")
    status = "extinct at tick " + str(extinct) if extinct else "ran to tick " + str(final_tick)
    title = f"{results_path.name}  —  {status}  —  final pop {final_pop}, species {final_spec}"

    # one combined dashboard
    fig = make_summary_figure(records, species_diets, title)
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
        ("brain_complexity.png",          plot_brain_complexity),
    ]
    for filename, plotter in panels:
        f, ax = plt.subplots(figsize=(8, 5))
        plotter(records, ax)
        f.tight_layout()
        path = out_dir / filename
        f.savefig(path, dpi=130)
        plt.close(f)
        print(f"[plots] wrote {path}")

    # species population chart needs the species_diets sidecar, so it doesn't fit
    # the (records, ax) shape used by the loop above.
    f, ax = plt.subplots(figsize=(10, 6))
    plot_species_populations(records, species_diets, ax)
    f.tight_layout()
    path = out_dir / "species_populations.png"
    f.savefig(path, dpi=130)
    plt.close(f)
    print(f"[plots] wrote {path}")

    if args.show:
        plt.show()
    else:
        plt.close(fig)


if __name__ == "__main__":
    main()
