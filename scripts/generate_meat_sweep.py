"""Generate a meat-nutrition sweep from a base predation map.

Copies a base `_predation` map — which already carries the starter organisms and
their 17-input brains — and writes one variant per meat-nutrition value, changing
ONLY `controls.foodTypes[0].nutrition` (meat = food type 0). Everything else
(geometry, organisms, other controls) is identical, so any difference across
variants is attributable to meat value alone.

Purpose: find the meat value at which scavengers/predators emerge (mouths eating
type-0 meat; killer cells appearing) and, at the high end, where the
death->scavenge recycling loop tips into runaway population growth. Reproduction
costs `foodNeeded = cells.length` (1 food/cell) and a corpse returns
`cells x meat`, so meat > 1.0 is energy-positive (see MAP_DESIGN.md); the sweep
brackets that 1.0 break-even from both sides.

Variants are written to `maps/meat_sweep/` so they don't collide with the main
distance sweep (`submit_all_maps.sh` only globs top-level `maps/map_500_d*.json`).

Usage:
    uv run scripts/generate_meat_sweep.py
    uv run scripts/generate_meat_sweep.py --base maps/map_500_d03_predation.json
    uv run scripts/generate_meat_sweep.py --values 0.25 0.5 0.75 1.0 1.25 1.5 2.0
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

REPO_ROOT   = Path(__file__).resolve().parents[1]
DEFAULT_BASE = REPO_ROOT / "maps" / "map_500_d05_predation.json"
OUT_DIR      = REPO_ROOT / "maps" / "meat_sweep"

# Brackets the 1.0 energy break-even: below (likely too poor for a scavenger
# niche), at 1.0 (pilots showed predators emerge, bounded), and above (energy-
# positive — expect runaway onset toward the top).
DEFAULT_VALUES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0]


def meat_tag(v: float) -> str:
    """0.25 -> '025', 1.0 -> '100', 2.0 -> '200' (sortable, dot-free)."""
    return f"{round(v * 100):03d}"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", type=Path, default=DEFAULT_BASE,
                   help="base _predation map to copy (must contain starter organisms)")
    p.add_argument("--values", type=float, nargs="+", default=DEFAULT_VALUES,
                   help="meat nutrition values to sweep")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    with args.base.open() as f:
        base = json.load(f)

    if not base.get("organisms"):
        raise SystemExit(f"ERROR: base map {args.base} has no starter organisms — "
                         f"pick a map that has founders dropped in.")
    if not base.get("controls", {}).get("deadTurnToFood"):
        print(f"WARN: base map {args.base} has deadTurnToFood=false; forcing it on "
              f"(a meat sweep only makes sense with predation enabled).")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = args.base.stem                       # e.g. map_500_d05_predation
    n_org = len(base["organisms"])

    print(f"base: {args.base.relative_to(REPO_ROOT)}  ({n_org} organisms)")
    print(f"{'meat':>6}  file")
    print("-" * 60)
    for v in args.values:
        env = json.loads(json.dumps(base))      # deep copy
        env["controls"]["foodTypes"][0]["nutrition"] = v
        env["controls"]["deadTurnToFood"] = True
        if isinstance(env.get("_meta"), dict):
            env["_meta"]["meat_nutrition"] = v
        out = OUT_DIR / f"{stem}_meat{meat_tag(v)}.json"
        with out.open("w") as f:
            json.dump(env, f)
        print(f"{v:>6}  {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
