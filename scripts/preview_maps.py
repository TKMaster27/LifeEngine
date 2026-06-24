"""Render a grid preview of the generated 500x500 distance maps. One panel per
distance level (d01 = closest clusters … dNN = farthest). Predation siblings are
geometrically identical, so only the normal maps are shown. Each food type is
coloured differently.

Usage:
    uv run scripts/preview_maps.py
"""

from __future__ import annotations
import json
import math
import re
from pathlib import Path

import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[1]
MAPS_DIR  = REPO_ROOT / "maps"
OUT       = REPO_ROOT / "maps" / "preview.png"

SIZE = 500
DIST_RE = re.compile(r"^map_500_d(\d+)\.json$")

# Food type -> colour, matching the analyzer's diet colours.
FOOD_COLOURS = {1: "#FF69B4", 2: "#FF0000", 3: "#FFFF00"}


def distance_maps() -> list[Path]:
    """Normal 500 distance maps, sorted by distance index (d01, d02, …)."""
    paths = [p for p in MAPS_DIR.glob("map_500_d*.json") if DIST_RE.match(p.name)]
    return sorted(paths, key=lambda p: int(DIST_RE.match(p.name).group(1)))


def main() -> None:
    maps = distance_maps()
    if not maps:
        print("No map_500_dNN.json maps found — run generate_maps.py first.")
        return

    n = len(maps)
    ncols = min(5, n)
    nrows = math.ceil(n / ncols)
    fig, axes = plt.subplots(nrows, ncols,
                             figsize=(2.6 * ncols, 2.6 * nrows),
                             squeeze=False)
    fig.suptitle("500×500 cluster-spacing maps (by distance)",
                 fontsize=14, fontweight="bold")

    marker_size = max(2, 200 / SIZE)
    for idx, ax in enumerate(axes.flat):
        if idx >= n:
            ax.axis("off")
            continue
        path = maps[idx]
        with path.open() as f:
            env = json.load(f)
        emitters = env["grid"]["emitters"]
        label = env.get("_meta", {}).get("distance", path.stem)
        pairwise = env.get("_meta", {}).get("pairwise_distance")
        for t, colour in FOOD_COLOURS.items():
            xs = [e["c"] for e in emitters if e["t"] == t]
            ys = [e["r"] for e in emitters if e["t"] == t]
            ax.scatter(xs, ys, c=colour, s=marker_size, edgecolors="none",
                       label=f"type {t}")
        ax.set_xlim(0, SIZE)
        ax.set_ylim(SIZE, 0)  # invert so screen-y matches editor
        ax.set_aspect("equal")
        title = f"{label}" + (f" — {pairwise:.0f} cells" if pairwise else "")
        ax.set_title(title, fontsize=9)
        ax.set_xticks([0, SIZE // 2, SIZE])
        ax.set_yticks([0, SIZE // 2, SIZE])
        ax.tick_params(labelsize=6)
        ax.grid(alpha=0.25, linestyle=":")

    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=3, fontsize=9,
               frameon=False, bbox_to_anchor=(0.5, -0.005))
    fig.tight_layout(rect=(0, 0.03, 1, 0.96))
    fig.savefig(OUT, dpi=140, bbox_inches="tight")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
