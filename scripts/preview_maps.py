"""Render a 3x3 grid preview of the generated maps. One row per size, one
column per distance level. Each food type is coloured differently.

Usage:
    uv run scripts/preview_maps.py
"""

from __future__ import annotations
import json
from pathlib import Path

import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[1]
MAPS_DIR  = REPO_ROOT / "maps"
OUT       = REPO_ROOT / "maps" / "preview.png"

SIZES = [100, 300, 500]
DISTANCES = ["close", "medium", "far"]

# Food type -> colour, matching the analyzer's diet colours.
FOOD_COLOURS = {1: "#FF69B4", 2: "#FF0000", 3: "#FFFF00"}


def main() -> None:
    fig, axes = plt.subplots(len(SIZES), len(DISTANCES),
                             figsize=(11, 11),
                             squeeze=False)
    fig.suptitle("Cluster-spacing experiment maps", fontsize=14, fontweight="bold")

    for row, size in enumerate(SIZES):
        for col, dist in enumerate(DISTANCES):
            ax = axes[row][col]
            path = MAPS_DIR / f"map_{size}_{dist}.json"
            with path.open() as f:
                env = json.load(f)
            emitters = env["grid"]["emitters"]
            # Marker size shrinks with map size so the checkerboard pattern is
            # readable on the largest maps without obscuring it on small ones.
            marker_size = max(2, 200 / size)
            for t, colour in FOOD_COLOURS.items():
                xs = [e["c"] for e in emitters if e["t"] == t]
                ys = [e["r"] for e in emitters if e["t"] == t]
                ax.scatter(xs, ys, c=colour, s=marker_size, edgecolors="none",
                           label=f"type {t}")
            ax.set_xlim(0, size)
            ax.set_ylim(size, 0)  # invert so screen-y matches editor
            ax.set_aspect("equal")
            ax.set_title(f"{size}×{size} — {dist}", fontsize=10)
            ax.set_xticks([0, size // 2, size])
            ax.set_yticks([0, size // 2, size])
            ax.tick_params(labelsize=7)
            ax.grid(alpha=0.25, linestyle=":")

    # one shared legend in the upper-left corner
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=3, fontsize=9,
               frameon=False, bbox_to_anchor=(0.5, -0.005))
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    fig.savefig(OUT, dpi=140, bbox_inches="tight")
    print(f"wrote {OUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
