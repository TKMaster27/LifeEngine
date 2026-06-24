"""Duplicate every `maps/map_*.json` to a `_predation.json` sibling with
`controls.deadTurnToFood = true`.

LEGACY: `generate_maps.py` now emits `_predation` siblings directly, so this
script is no longer part of the normal workflow. It is kept for one-off use on
hand-made maps that were not produced by `generate_maps.py`. Running it on the
generated maps is harmless — the `_predation` siblings already exist and are
skipped.

Base maps are duplicated; files that already end in `_predation.json` are
skipped so re-running is idempotent.

Run with:
    uv run scripts/duplicate_maps_predation.py
"""

from __future__ import annotations

import json
from pathlib import Path

MAPS_DIR = Path(__file__).resolve().parent.parent / "maps"
SUFFIX = "_predation"


def predation_path(src: Path) -> Path:
    return src.with_name(f"{src.stem}{SUFFIX}.json")


def is_predation_file(p: Path) -> bool:
    return p.stem.endswith(SUFFIX)


def duplicate(src: Path, *, force: bool = False) -> tuple[Path, str]:
    """Return (output_path, status) where status is 'wrote' / 'skipped'."""
    dst = predation_path(src)
    if dst.exists() and not force:
        return dst, "skipped (exists)"

    with src.open() as f:
        data = json.load(f)

    controls = data.setdefault("controls", {})
    controls["deadTurnToFood"] = True

    meta = data.setdefault("_meta", {})
    meta["predation_enabled"] = True
    meta["derived_from"] = src.name

    with dst.open("w") as f:
        json.dump(data, f)
    return dst, "wrote"


def main() -> None:
    sources = sorted(p for p in MAPS_DIR.glob("map_*.json") if not is_predation_file(p))
    if not sources:
        print(f"No source maps found under {MAPS_DIR}")
        return
    wrote = skipped = 0
    for src in sources:
        dst, status = duplicate(src)
        marker = "+" if status == "wrote" else "·"
        print(f"  {marker} {src.name:40s} → {dst.name}  [{status}]")
        if status == "wrote":
            wrote += 1
        else:
            skipped += 1
    print(f"\nDone — {wrote} written, {skipped} skipped (already existed).")


if __name__ == "__main__":
    main()
