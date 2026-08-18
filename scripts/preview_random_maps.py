"""Render a grid preview of the random-environment sweep maps — one panel per
(patch scale x scarcity) cell, so the landscape the sweep actually runs on can be
eyeballed before 36 jobs go to the cluster.

Rows = Perlin resolution (patch scale, coarse at the top), columns = emitter
count (scarcity). Each food type is coloured differently and founder organisms
are marked, so it is obvious at a glance whether all three types were seeded and
whether the founders sit next to a food ribbon.

Predation siblings are geometrically identical to their normal twin, so only the
normal maps are drawn.

Usage:
    uv run scripts/preview_random_maps.py
    uv run scripts/preview_random_maps.py --replicate 2 --out maps/random_preview_n2.png
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

import matplotlib.pyplot as plt

REPO_ROOT = Path(__file__).resolve().parents[1]
SWEEP_DIR = REPO_ROOT / "maps" / "random_sweep"

NAME_RE = re.compile(r"^rand_(\d+)_r(\d+)_e(\d+)(?:_n(\d+))?$")   # normal arm only

# Food type -> colour, matching preview_maps.py / the analyser's diet colours.
FOOD_COLOURS = {1: "#FF69B4", 2: "#FF0000", 3: "#FFFF00"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--replicate", type=int, default=1, help="which noise field to draw")
    p.add_argument("--out", type=Path, default=None,
                   help="output PNG (default maps/random_preview[_nN].png)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    maps = []
    for p in SWEEP_DIR.glob("rand_*.json"):
        m = NAME_RE.match(p.stem)
        if not m:
            continue
        rep = int(m.group(4) or 1)
        if rep != args.replicate:
            continue
        maps.append((int(m.group(2)), int(m.group(3)), p))
    if not maps:
        print(f"No maps/random_sweep/rand_*_n{args.replicate}.json — run "
              f"`node scripts/generate_random_maps.js` first.")
        return

    scales     = sorted({s for s, _, _ in maps})
    scarcities = sorted({e for _, e, _ in maps})
    lookup     = {(s, e): p for s, e, p in maps}

    fig, axes = plt.subplots(len(scales), len(scarcities),
                             figsize=(4 * len(scarcities), 4 * len(scales)),
                             squeeze=False)
    for ri, scale in enumerate(scales):
        for ci, scarcity in enumerate(scarcities):
            ax = axes[ri][ci]
            path = lookup.get((scale, scarcity))
            if path is None:
                ax.axis("off")
                continue
            with path.open() as f:
                env = json.load(f)
            meta = env.get("_meta", {}) or {}
            size = meta.get("size", env.get("num_cols", 500))

            by_type: dict[int, list[tuple[int, int]]] = {}
            for e in env["grid"]["emitters"]:
                by_type.setdefault(e.get("t", 1), []).append((e["c"], e["r"]))
            for t, pts in sorted(by_type.items()):
                ax.scatter([c for c, _ in pts], [r for _, r in pts], s=0.6,
                           c=FOOD_COLOURS.get(t, "#999999"), linewidths=0,
                           label=f"type {t}")

            if env.get("organisms"):
                ax.scatter([o["c"] for o in env["organisms"]],
                           [o["r"] for o in env["organisms"]],
                           s=70, facecolors="none", edgecolors="#00e5ff", linewidths=1.4,
                           label="founders")

            ax.set_xlim(0, size)
            ax.set_ylim(size, 0)               # screen orientation: row 0 at top
            ax.set_aspect("equal")
            ax.set_facecolor("#0d0d0d")
            ax.set_xticks([]); ax.set_yticks([])
            ax.set_title(f"res {scale} · {scarcity} emitters\n"
                         f"{meta.get('islands', '?')} islands · "
                         f"mean dist {meta.get('mean_dist_to_food', '?')} · "
                         f"{meta.get('open_regions', '?')} pockets",
                         fontsize=9)
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="lower center", ncol=len(labels), frameon=False,
               markerscale=4, fontsize=9)
    fig.suptitle(f"Random-environment sweep — noise field n{args.replicate} "
                 f"(rows: patch scale, columns: food supply)", fontsize=12)
    fig.tight_layout(rect=(0, 0.035, 1, 0.98))

    out = args.out or (REPO_ROOT / "maps" /
                       (f"random_preview_n{args.replicate}.png" if args.replicate != 1
                        else "random_preview.png"))
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=130, facecolor="white")
    print(f"wrote {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
