"""Generate a diet-penalty sweep from the middle-distance (d05) maps.

Copies the base maps — which already carry the starter organisms and their
17-input brains — and writes one variant per diet-penalty setting, changing ONLY
`controls.dietPenaltyExponent` (and `dietPenaltyStrength` if `--strength` is
given). Everything else (geometry, organisms, meat value, other controls) is
identical, so any difference across variants is attributable to the diet-breadth
penalty alone.

The penalty is applied in the live eating path (`MouthCell.eatNeighbor`): a mouth
eating on-diet food absorbs `a / n^p` of its nutrition, where `n` is the number of
food types in the organism's diet (a specialist, `n == 1`, always gets 1.0) and
off-diet food is absorbed at 0.05. With `a = 1` the exponent `p` is the single
"how steeply is diet breadth punished" knob:

    p     n=2    n=3    n=4
    0.0   1.00   1.00   1.00   no penalty (control — generalism is free)
    0.5   0.71   0.58   0.50   old code default (1/sqrt(n))
    1.0   0.50   0.33   0.25   current map value (1/n)
    1.5   0.35   0.19   0.13
    2.0   0.25   0.11   0.06   harsh

Both arms are generated from d05: the **normal** map (`deadTurnToFood = false`)
and the **predation** map (`deadTurnToFood = true`). Meat (type 0) counts toward
diet breadth `n`, so the predation arm asks whether the penalty can hold
specialisation up against the extra `{plant, meat}` food source.

Variants are written to `maps/diet_sweep/` so they don't collide with the main
distance sweep (`submit_all_maps.sh` only globs top-level `maps/map_500_d*.json`).

Usage:
    uv run scripts/generate_diet_sweep.py
    uv run scripts/generate_diet_sweep.py --exponents 0 0.5 1 1.5 2 --strength 1.0
    uv run scripts/generate_diet_sweep.py --bases maps/map_500_d05_predation.json
    uv run scripts/generate_diet_sweep.py --no-clear      # keep existing variants
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR   = REPO_ROOT / "maps" / "diet_sweep"

# Middle distance (d05), both arms. Both already carry founders + 17-input brains.
DEFAULT_BASES = [
    REPO_ROOT / "maps" / "map_500_d05.json",
    REPO_ROOT / "maps" / "map_500_d05_predation.json",
]

# Brackets the current map setting (p=1) with a no-penalty control at one end and
# a harsh penalty at the other; p=0.5 is the historical code default.
DEFAULT_EXPONENTS = [0.0, 0.5, 1.0, 1.5, 2.0]
DEFAULT_STRENGTH  = 1.0


def tag(v: float) -> str:
    """0.0 -> '000', 0.5 -> '050', 2.0 -> '200' (sortable, dot-free)."""
    return f"{round(v * 100):03d}"


def variant_name(stem: str, p: float, a: float) -> str:
    """map_500_d05 + p=0.5 -> 'map_500_d05_dietp050'.

    The strength suffix is emitted only when `a` is non-default, so the common
    a=1 sweep keeps short names (and the analyser's regex stays simple).
    """
    name = f"{stem}_dietp{tag(p)}"
    if abs(a - DEFAULT_STRENGTH) > 1e-9:
        name += f"a{tag(a)}"
    return name


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--bases", type=Path, nargs="+", default=DEFAULT_BASES,
                   help="base maps to copy (must contain starter organisms)")
    p.add_argument("--exponents", type=float, nargs="+", default=DEFAULT_EXPONENTS,
                   help="dietPenaltyExponent (p) values to sweep")
    p.add_argument("--strength", type=float, default=DEFAULT_STRENGTH,
                   help="dietPenaltyStrength (a), held fixed across the sweep")
    p.add_argument("--conservatism", type=int, default=None,
                   help="override dietMutationConservatism %% (default: keep the base map's)")
    p.add_argument("--no-clear", dest="clear", action="store_false",
                   help="keep existing maps/diet_sweep/*.json (default: wipe first, "
                        "since submit_diet_sweep.sh globs the whole directory)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.clear:
        stale = sorted(OUT_DIR.glob("*.json"))
        for f in stale:
            f.unlink()
        if stale:
            print(f"cleared {len(stale)} stale variant(s) from {OUT_DIR.relative_to(REPO_ROOT)}")

    print(f"strength a = {args.strength}   exponents p = {args.exponents}")
    print(f"{'arm':>10} {'p':>5} {'eff(n=2)':>9}  file")
    print("-" * 76)

    written = 0
    for base_path in args.bases:
        with base_path.open() as f:
            base = json.load(f)

        if not base.get("organisms"):
            raise SystemExit(f"ERROR: base map {base_path} has no starter organisms — "
                             f"every run would extinct at tick 1.")
        if "controls" not in base:
            raise SystemExit(f"ERROR: base map {base_path} has no `controls` block.")

        stem = base_path.stem                       # e.g. map_500_d05_predation
        arm  = "predation" if base["controls"].get("deadTurnToFood") else "normal"

        for p in args.exponents:
            env = json.loads(json.dumps(base))       # deep copy
            env["controls"]["dietPenaltyStrength"] = args.strength
            env["controls"]["dietPenaltyExponent"] = p
            if args.conservatism is not None:
                env["controls"]["dietMutationConservatism"] = args.conservatism
            env["_meta"] = {
                **(env.get("_meta") or {}),
                "sweep": "diet_penalty",
                "base_map": base_path.name,
                "arm": arm,
                "dietPenaltyStrength": args.strength,
                "dietPenaltyExponent": p,
                "dietMutationConservatism": env["controls"].get("dietMutationConservatism"),
            }
            out = OUT_DIR / f"{variant_name(stem, p, args.strength)}.json"
            with out.open("w") as f:
                json.dump(env, f)
            eff2 = args.strength / (2 ** p)          # generalist efficiency at n=2
            print(f"{arm:>10} {p:>5} {eff2:>9.2f}  {out.relative_to(REPO_ROOT)}")
            written += 1

    print(f"\nwrote {written} variant(s) to {OUT_DIR.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
