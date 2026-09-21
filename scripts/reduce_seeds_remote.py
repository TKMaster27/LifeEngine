"""Reduce every seed JSON under results/ to one CSV row. Stdlib only.

Mirrors scripts/dashboard.py::_reduce_seed exactly so the numbers this produces
are directly comparable with the dashboard and with scripts/complexity.py.

Run on the machine that holds the results; only the CSV needs to travel.

    nice -n 10 python3 reduce_seeds_remote.py ~/LifeEngine/results out.csv 3
"""
import csv
import json
import math
import os
import re
import sys
from collections import defaultdict
from multiprocessing import Pool

TAIL_FRAC = 0.10
MEAT_TYPE = 0
PLANT_TYPES = (1, 2, 3)
GENERALIST_BREADTH = 1.5
CELL_TYPES = ["mouth", "producer", "mover", "killer", "armor", "eye"]
SUMMARY_KEYS = ("seed", "total_ticks", "reached_max_ticks", "extinction_tick",
                "final_population", "final_species", "ticks_per_second")
WIN_KEYS = ("tick_record", "pop_counts", "species_counts", "av_cells",
            "av_cell_counts", "av_connections", "av_hidden_nodes")
RAND_ENV_RE = re.compile(r"^rand_(\d+)_r(\d+)_e(\d+)(?:_n(\d+))?(_predation)?$")

DIET_LABELS = {"type1_only": "Type 1 specialists", "type2_only": "Type 2 specialists",
               "type3_only": "Type 3 specialists", "generalist": "Generalists",
               "none": "No diet / mouth"}


def tail_mean(series, frac=TAIL_FRAC):
    vals = [v for v in series if isinstance(v, (int, float))]
    if not vals:
        return None
    n = max(1, int(len(vals) * frac))
    return sum(vals[-n:]) / n


def cell_mix(counts_series, frac=TAIL_FRAC):
    dicts = [c for c in counts_series if isinstance(c, dict) and c]
    if not dicts:
        return None, None, {}
    n = max(1, int(len(dicts) * frac))
    acc = defaultdict(float)
    for d in dicts[-n:]:
        for k, v in d.items():
            if isinstance(v, (int, float)):
                acc[k] += v / n
    total = sum(acc.values())
    if total <= 0:
        return 0, 0.0, {}
    shares = {k: v / total for k, v in acc.items()}
    richness = sum(1 for v in acc.values() if v >= 0.05)
    entropy = -sum(p * math.log2(p) for p in shares.values() if p > 0)
    return richness, entropy, shares


def label_rand(env):
    m = RAND_ENV_RE.match(env)
    if not m:
        return {"scale": None, "scarcity": None, "replicate": None,
                "arm": "predation" if env.endswith("_predation") else "normal"}
    return {"scale": int(m.group(2)), "scarcity": int(m.group(3)),
            "replicate": int(m.group(4) or 1),
            "arm": "predation" if m.group(5) else "normal"}


def reduce_seed(summary, win, species):
    richness, entropy, shares = cell_mix(win.get("av_cell_counts") or [])
    live = [s for s in (species or {}).values() if (s.get("population") or 0) > 0]
    total = sum(s["population"] for s in live)

    plant_breadth = total_breadth = specialists = meat_pop = 0.0
    breadth_pop = defaultdict(float)
    plant_types = set()
    type_pop = defaultdict(float)
    niche_pop = defaultdict(float)
    for s in live:
        pop = s["population"]
        diets = set(s.get("mouth_diets") or [])
        plants = diets - {MEAT_TYPE}
        plant_breadth += pop * len(plants)
        total_breadth += pop * max(len(diets), 1)
        specialists += pop if len(plants) == 1 else 0
        meat_pop += pop if MEAT_TYPE in diets else 0
        breadth_pop[len(plants)] += pop
        plant_types |= plants
        for t in plants:
            type_pop[t] += pop / len(plants)
        niche_pop[frozenset(plants)] += pop

    ext = summary.get("extinction_tick")
    out = {
        "seed": summary.get("seed"),
        "total_ticks": summary.get("total_ticks"),
        "extinct": ext is not None,
        "extinction_tick": ext,
        "final_pop": summary.get("final_population") or 0,
        "final_species": summary.get("final_species") or 0,
        "ticks_per_second": summary.get("ticks_per_second"),
        "av_cells": tail_mean(win.get("av_cells") or []),
        "cell_richness": richness,
        "cell_entropy": entropy,
        "connections": tail_mean(win.get("av_connections") or []),
        "hidden_nodes": tail_mean(win.get("av_hidden_nodes") or []),
        "species_count": tail_mean(win.get("species_counts") or []),
        "pop": tail_mean(win.get("pop_counts") or []),
        "plant_breadth": (plant_breadth / total) if total else None,
        "total_breadth": (total_breadth / total) if total else None,
        "specialist_pct": (100 * specialists / total) if total else None,
        "meat_pct": (100 * meat_pop / total) if total else None,
        "plant_types": "".join(str(t) for t in sorted(plant_types)),
    }
    for t in CELL_TYPES:
        out[f"{t}_pct"] = 100 * shares.get(t, 0.0)
    av = out["av_cells"]
    out["mouth_cells"] = (av * shares.get("mouth", 0.0)) if av is not None else None
    out["nonmouth_cells"] = (av * (1 - shares.get("mouth", 0.0))) if av is not None else None
    for n in range(4):
        out[f"breadth{n}_pct"] = (100 * breadth_pop.get(n, 0.0) / total) if total else None
    for t in PLANT_TYPES:
        out[f"diet{t}_pct"] = (100 * type_pop.get(t, 0.0) / total) if total else None
    sh = [(type_pop.get(t, 0.0) / total) if total else 0.0 for t in PLANT_TYPES]
    out["diet_shannon"] = (-sum(p * math.log2(p) for p in sh if p > 0)) if total else None
    out["diet_types_held"] = sum(1 for p in sh if p >= 0.05) if total else None
    ns = [v / total for v in niche_pop.values()] if total else []
    out["niche_shannon"] = (-sum(p * math.log2(p) for p in ns if p > 0)) if total else None
    out["niche_count"] = sum(1 for p in ns if p >= 0.05) if total else None
    if not total:
        out["dominant_diet"] = DIET_LABELS["none"]
    elif (plant_breadth / total) >= GENERALIST_BREADTH:
        out["dominant_diet"] = DIET_LABELS["generalist"]
    else:
        top = max(PLANT_TYPES, key=lambda t: type_pop.get(t, 0.0))
        out["dominant_diet"] = (DIET_LABELS[f"type{top}_only"] if type_pop.get(top)
                                else DIET_LABELS["none"])
    return out


def one(args):
    env, path = args
    try:
        with open(path) as f:
            d = json.load(f)
        fr = d.get("fossil_record", {}) or {}
        summary = {k: d.get(k) for k in SUMMARY_KEYS}
        win = fr.get("window_records") or fr.get("records") or {}
        # Keep only the arrays we reduce, then drop the rest before it is copied
        # back to the parent process.
        win = {k: win.get(k) or [] for k in WIN_KEYS}
        species = {k: {"population": v.get("population"),
                       "mouth_diets": v.get("mouth_diets")}
                   for k, v in (fr.get("species") or {}).items()}
        del d, fr
        row = {"env": env, "file": os.path.basename(path),
               **label_rand(env), **reduce_seed(summary, win, species)}
        print(f"ok {env}/{os.path.basename(path)}", flush=True)
        return row
    except Exception as exc:                       # a bad file must not kill the run
        print(f"FAIL {env}/{os.path.basename(path)}: {exc}", flush=True)
        return None


def main():
    root = os.path.expanduser(sys.argv[1])
    out_csv = sys.argv[2]
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 3

    jobs = []
    for env in sorted(os.listdir(root)):
        d = os.path.join(root, env)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if fn.startswith("seed_") and fn.endswith(".json") and not fn.endswith("_world.json"):
                jobs.append((env, os.path.join(d, fn)))
    print(f"{len(jobs)} seed files across {len({e for e, _ in jobs})} envs", flush=True)

    with Pool(workers) as pool:
        rows = [r for r in pool.imap_unordered(one, jobs, chunksize=1) if r]

    if not rows:
        print("nothing reduced", file=sys.stderr)
        return 1
    cols = list(rows[0].keys())
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    rows.sort(key=lambda r: (r["env"], r.get("seed") or 0))
    with open(out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows -> {out_csv}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
