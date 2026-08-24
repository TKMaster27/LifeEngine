"""Measure the resource landscape of ANY map JSON, ring or random.

`scripts/generate_random_maps.js` records measured landscape descriptors in each
random map's `_meta` (mean_dist_to_food, islands, open_regions, ...). The
hand-built ring maps `maps/map_500_d*.json` carry no `_meta` at all -- they
predate that code path -- so they have nothing to plot against, and the
simple-vs-complex comparison has no shared x-axis.

Both families do store the same thing: `grid.emitters = [{c, r, t}]`. So one
measurement pass covers everything, and the numbers are comparable with the
random sweep's `_meta` *provided* this file mirrors the JS exactly. It does,
including two quirks worth stating rather than silently "fixing":

  - `island_size_median` takes the UPPER median on even counts (the JS indexes
    `sizes[floor(len/2)]` into an ascending sort), not numpy's midpoint average.
  - `mean_island_spacing` is EUCLIDEAN (`Math.hypot`) even though every other
    distance here is Chebyshev. Replicating the inconsistency is what makes
    `--verify` pass.

Beyond parity it adds one new descriptor, `switch_cost`: the mean extra travel,
in cells, from any free cell to a SECOND food type beyond the nearest one. The
`_meta` axes measure how far food is; this measures how far *different* food is,
which is the quantity the adaptive-radiation hypothesis is actually about.

Usage:
    uv run scripts/landscape_metrics.py                        # measure all maps -> CSV
    uv run scripts/landscape_metrics.py maps/map_500_d05.json  # one map, to stdout
    uv run scripts/landscape_metrics.py --verify maps/random_sweep
"""

from __future__ import annotations
import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

REPO_ROOT = Path(__file__).resolve().parents[1]
MAPS_DIR  = REPO_ROOT / "maps"
OUT_CSV   = REPO_ROOT / "analysis" / "landscape_metrics.csv"

# Same constants the JS uses (scripts/generate_random_maps.js DEF, openRegions).
MIN_ISLAND_CELLS = 15
MIN_OPEN_CELLS   = 100
FOOD_TYPES       = (1, 2, 3)

METRICS_VERSION = 1

# Where a bare env name might live. Order matters: `maps/<env>.json` first so a
# ring map never resolves to a sweep copy of itself.
MAP_SUBDIRS = ("", "random_sweep", "random_near", "diet_sweep", "meat_sweep")

CONN8 = np.ones((3, 3), dtype=bool)
CONN4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


def resolve_map(env_name: str) -> Path | None:
    """Env/result folder name -> the map file it was run from."""
    stem = env_name[:-5] if env_name.endswith(".json") else env_name
    for sub in MAP_SUBDIRS:
        cand = (MAPS_DIR / sub / f"{stem}.json") if sub else (MAPS_DIR / f"{stem}.json")
        if cand.is_file():
            return cand
    return None


def load_emitters(path: Path):
    """-> (size, emitter array [c, r, t]). Fails loudly rather than measuring
    garbage: a non-square grid would silently transpose every index below."""
    with open(path) as f:
        doc = json.load(f)
    grid = doc.get("grid") or {}
    cols, rows = grid.get("cols"), grid.get("rows")
    if not cols or not rows:
        raise ValueError(f"{path.name}: grid has no cols/rows")
    if cols != rows:
        raise ValueError(f"{path.name}: non-square grid {cols}x{rows} unsupported")
    em = grid.get("emitters") or []
    if not em:
        raise ValueError(f"{path.name}: no emitters")
    arr = np.array([(e["c"], e["r"], e["t"]) for e in em], dtype=np.int32)
    return int(cols), arr, doc


def controls_of(doc) -> dict:
    """The controls that make a map a different experiment rather than a
    different environment."""
    c = doc.get("controls") or {}
    return {
        "diet_penalty_exponent": c.get("dietPenaltyExponent"),
        "diet_penalty_strength": c.get("dietPenaltyStrength"),
        "meat_nutrition": next((f.get("nutrition") for f in (c.get("foodTypes") or [])
                                if f.get("id") == 0), None),
        "predation_enabled": bool(c.get("deadTurnToFood")),
    }


def _mask(arr, size, food_type=None):
    """Boolean emitter mask, optionally restricted to one food type."""
    sel = arr if food_type is None else arr[arr[:, 2] == food_type]
    m = np.zeros((size, size), dtype=bool)
    if len(sel):
        m[sel[:, 1], sel[:, 0]] = True      # [row, col]
    return m


def _chebyshev_dt(mask):
    """Distance from every cell to the nearest True in `mask`, 8-neighbour ==
    Chebyshev. Mirrors the JS multi-source BFS in `distanceToNearest` (L209)."""
    if not mask.any():
        return None
    return ndimage.distance_transform_cdt(~mask, metric="chessboard").astype(np.int32)


def measure_map(path: Path) -> dict:
    path = Path(path).resolve()
    size, arr, doc = load_emitters(path)
    mask = _mask(arr, size)

    # --- islands: 8-connected components of the emitter band (JS findIslands) --
    lbl, n_isl = ndimage.label(mask, structure=CONN8)
    sizes = np.bincount(lbl.ravel())[1:]                 # drop background
    big = sizes >= MIN_ISLAND_CELLS
    asc = np.sort(sizes)
    # Upper median, as the JS does -- see module docstring.
    median = int(asc[len(asc) // 2]) if len(asc) else 0

    # --- distance to food (JS distanceToNearest + stats) ----------------------
    dist = _chebyshev_dt(mask)
    free = dist > 0                                      # excludes emitter cells
    mean_dist = float(dist[free].mean()) if free.any() else 0.0
    max_dist  = int(dist[free].max()) if free.any() else 0

    # --- island spacing: nearest-neighbour EUCLIDEAN centroid distance among
    #     sizeable islands (JS stats uses Math.hypot here) --------------------
    spacing = 0.0
    if big.sum() > 1:
        ids = np.nonzero(big)[0] + 1
        cent = np.array(ndimage.center_of_mass(mask, lbl, ids))   # (row, col)
        d = np.hypot(cent[:, 1][:, None] - cent[:, 1][None, :],
                     cent[:, 0][:, None] - cent[:, 0][None, :])
        np.fill_diagonal(d, np.inf)
        spacing = float(d.min(axis=1).mean())

    # --- open regions: 4-connected background (JS openRegions) ---------------
    olbl, _ = ndimage.label(~mask, structure=CONN4)
    osizes = np.bincount(olbl.ravel())[1:]
    n_free = int((~mask).sum())
    largest_open = float(osizes.max() / n_free) if len(osizes) and n_free else 0.0

    per_type = {t: int((arr[:, 2] == t).sum()) for t in FOOD_TYPES}

    out = {
        "map":                   path.stem,
        "map_path":              str(path.relative_to(REPO_ROOT)),
        "size":                  size,
        "emitters_total":        int(len(arr)),
        "emitter_fraction":      round(len(arr) / (size * size), 5),
        "islands":               int(n_isl),
        "islands_ge_min":        int(big.sum()),
        "island_size_median":    median,
        "island_size_max":       int(asc[-1]) if len(asc) else 0,
        "mean_dist_to_food":     round(mean_dist, 2),
        "max_dist_to_food":      max_dist,
        "mean_island_spacing":   round(spacing, 2),
        "open_regions":          int((osizes >= MIN_OPEN_CELLS).sum()),
        "open_regions_all":      int(len(osizes)),
        "largest_open_fraction": round(largest_open, 3),
        **{f"emitters_type{t}": per_type[t] for t in FOOD_TYPES},
        **switch_cost(arr, size, mask),
        "food_types_present":    int(sum(1 for t in FOOD_TYPES if per_type[t] > 0)),
        # Not landscape geometry, but it decides whether two maps are the same
        # EXPERIMENT: the diet-penalty and meat sweeps reuse one map and vary the
        # fitness rules, so they must not be pooled with the baseline arms.
        **controls_of(doc),
        "map_sha1":              hashlib.sha1(arr.tobytes()).hexdigest()[:12],
        "metrics_version":       METRICS_VERSION,
    }
    return out


def switch_cost(arr, size, mask) -> dict:
    """How far is a SECOND food type?

    Per-type Chebyshev distance transforms, then per free cell the gap between
    the nearest type and the next-nearest. Averaged over free cells this is
    "extra travel, in cells, to reach a different resource" -- low where types
    interleave, high where each type sits in its own isolated cluster. Ring maps
    should score high and rise with cluster separation; interleaved Perlin
    ribbons should score low.

    `dist_to_2nd_type` is the absolute version (no subtraction), kept because it
    is the one that answers "how far must an organism travel to switch diet".
    """
    dts = [_chebyshev_dt(_mask(arr, size, t)) for t in FOOD_TYPES]
    dts = [d for d in dts if d is not None]
    if len(dts) < 2:
        return {"switch_cost": None, "dist_to_2nd_type": None, "types_measured": len(dts)}
    stack = np.sort(np.stack(dts, axis=0), axis=0)       # nearest first
    free = ~mask
    gap = (stack[1] - stack[0])[free]
    return {
        "switch_cost":      round(float(gap.mean()), 2),
        "dist_to_2nd_type": round(float(stack[1][free].mean()), 2),
        "types_measured":   len(dts),
    }


# ── verification against the generator's own numbers ───────────────────────
EXACT_KEYS = ["emitters_total", "islands", "islands_ge_min", "island_size_median",
              "island_size_max", "open_regions", "open_regions_all"]
CLOSE_KEYS = ["mean_dist_to_food", "max_dist_to_food", "mean_island_spacing",
              "emitter_fraction", "largest_open_fraction"]


def verify(folder: Path, tol: float = 0.011) -> int:
    """Recompute maps that HAVE a `_meta` and diff. If the Python disagrees with
    the JS here, the ring-map numbers it produces cannot be trusted either."""
    paths = sorted(folder.glob("*.json"))
    checked = failed = 0
    for p in paths:
        with open(p) as f:
            meta = (json.load(f) or {}).get("_meta")
        if not isinstance(meta, dict) or "mean_dist_to_food" not in meta:
            continue
        got = measure_map(p)
        checked += 1
        bad = []
        for k in EXACT_KEYS:
            if k in meta and int(meta[k]) != int(got[k]):
                bad.append(f"{k}: meta={meta[k]} got={got[k]}")
        for k in CLOSE_KEYS:
            if k in meta and abs(float(meta[k]) - float(got[k])) > tol:
                bad.append(f"{k}: meta={meta[k]} got={got[k]}")
        pt = meta.get("emitters_per_type") or {}
        for t in FOOD_TYPES:
            if str(t) in pt and int(pt[str(t)]) != got[f"emitters_type{t}"]:
                bad.append(f"type{t}: meta={pt[str(t)]} got={got[f'emitters_type{t}']}")
        if bad:
            failed += 1
            print(f"FAIL {p.name}")
            for b in bad:
                print(f"       {b}")
    if not checked:
        print(f"\nno maps in {folder} carry measured _meta — nothing to compare")
        return 0
    print(f"\n{checked - failed}/{checked} maps match the generator's _meta"
          f"{' — PARITY OK' if not failed else ''}")
    return 1 if failed else 0


def all_maps() -> list[Path]:
    """Every map, ONE row per name.

    The sweep fleets overlap: maps/random_near (the 20-seed sweep) regenerated
    several landscapes that maps/random_sweep already held, byte for byte. Both
    copies run under the SAME results/<env>/ folder, so emitting both would put
    two rows under one `map` key -- and `complexity.attach_landscape` left-joins
    this table onto the seed table on exactly that key, which would silently
    duplicate every seed of the twelve shared landscapes. De-duplicate here, in
    MAP_SUBDIRS order, the same precedence `resolve_map` uses."""
    out, seen = [], {}
    for sub in MAP_SUBDIRS:
        d = (MAPS_DIR / sub) if sub else MAPS_DIR
        for p in sorted(d.glob("*.json")):
            if p.stem in seen:
                # Skipping the copy is only safe while the copies AGREE. If they
                # ever diverge, results/<p.stem>/ pools seeds from two different
                # landscapes and no downstream table can untangle it, so say so
                # rather than let precedence decide silently.
                if p.read_bytes() != seen[p.stem].read_bytes():
                    print(f"WARNING: {p} differs from {seen[p.stem]} but shares "
                          f"its name; measuring the latter", file=sys.stderr)
                continue
            seen[p.stem] = p
            out.append(p)
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("maps", nargs="*", help="map files to measure (default: all)")
    ap.add_argument("--verify", metavar="DIR",
                    help="recompute maps in DIR and diff against their _meta")
    ap.add_argument("--out", default=str(OUT_CSV))
    args = ap.parse_args()

    if args.verify:
        return verify(Path(args.verify))

    paths = [Path(m) for m in args.maps] if args.maps else all_maps()
    rows = []
    for p in paths:
        try:
            rows.append(measure_map(p))
        except Exception as e:                      # a bad map shouldn't kill the sweep
            print(f"skip {p.name}: {e}", file=sys.stderr)
    if not rows:
        print("nothing measured", file=sys.stderr)
        return 1

    if args.maps:
        for r in rows:
            print(json.dumps(r, indent=2))
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cols = list(rows[0].keys())
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} maps -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
