#!/usr/bin/env python3
"""promote_brain.py — transplant the best-evolved brain from a headless run
into an experiment file so the next run starts with a viable founder.

Iterative workflow:
    node src/headless.js --load Experiment1_Base.json --max-ticks 5000 \
                          --output results.json
    uv run scripts/promote_brain.py \
            --results results.json \
            --experiment Experiment1_Base.json
    # → Experiment1_Base.json now seeds every founder with the promoted brain.
    # → repeat.

By default picks the rank-0 organism from `living_organisms_ranked` (sorted by
cumulative_pop, then fitness, then lifetime). Use --rank N to pick another, or
--pick-founder to promote a `founder_brain` from `founder_brains_ranked`
(useful when extinction killed the lineage but the founder weights were good).

Supports all three brain serialisation formats:
    legacy        — Phase-1 two-layer  (w1/w2)
    neat-v1       — Phase-2 NEAT       (genome with weighted connections)
    hyperneat-v1  — Phase-3 HyperNEAT  (CPPN + cached substrate)

The promoted brain is written verbatim into EVERY founder in the experiment's
`organisms` array, and also into each entry of `fossil_record.species[*]` so
loads stay consistent.

The anatomy of the promoted organism must match the experiment's founder
anatomy — otherwise this would silently change the morphology you're holding
fixed. Use --allow-anatomy-mismatch to override.
"""

import argparse
import json
import sys
from pathlib import Path


# ─── Helpers ────────────────────────────────────────────────────────────────

def anatomy_sig(cells):
    """Compute the same anatomy signature used in headless.js."""
    parts = []
    for c in cells:
        s = f"{c['loc_col']},{c['loc_row']}:{c['state']['name']}"
        if "diet" in c and isinstance(c["diet"], (int, float)):
            s += f"/d{int(c['diet'])}"
        if "direction" in c and isinstance(c["direction"], (int, float)):
            s += f"/r{int(c['direction'])}"
        parts.append(s)
    return "|".join(sorted(parts))


def brain_format(brain):
    """Return one of {'legacy', 'neat-v1', 'hyperneat-v1', 'unknown'}."""
    if not brain or not isinstance(brain, dict):
        return "unknown"
    if brain.get("format") == "hyperneat-v1":
        return "hyperneat-v1"
    if brain.get("format") == "neat-v1":
        return "neat-v1"
    if "w1" in brain and "w2" in brain:
        return "legacy"
    return "unknown"


def brain_shape(brain):
    """Return (n_inputs, n_hidden, n_outputs, n_enabled_connections) for any
    format. Some entries may be `None` when the format doesn't track them."""
    fmt = brain_format(brain)
    if fmt == "legacy":
        return (
            brain.get("n_inputs", 0),
            brain.get("n_hidden", 0),
            brain.get("n_outputs", 0),
            (brain.get("n_inputs", 0) * brain.get("n_hidden", 0)
             + brain.get("n_hidden", 0) * brain.get("n_outputs", 0)),
        )
    if fmt == "neat-v1":
        g = brain.get("genome", {})
        n_in  = len(g.get("inputs", []))
        n_h   = len(g.get("hiddens", []))
        n_out = len(g.get("outputs", []))
        n_enabled = sum(1 for c in g.get("connections", []) if c.get("enabled", True))
        return (n_in, n_h, n_out, n_enabled)
    if fmt == "hyperneat-v1":
        # Substrate sizes (the genome cache).
        g = brain.get("genome", {})
        n_in  = len(g.get("inputs", []))
        n_h   = len(g.get("hiddens", []))
        n_out = len(g.get("outputs", []))
        # CPPN sizes are also useful — return enabled CPPN connections.
        cppn = brain.get("cppn", {}) or {}
        cppn_conns = sum(1 for c in cppn.get("connections", []) if c.get("enabled", True))
        return (n_in, n_h, n_out, cppn_conns)
    return (None, None, None, None)


def print_brain_summary(label, brain):
    fmt = brain_format(brain)
    n_in, n_h, n_out, n_conn = brain_shape(brain)
    print(f"[promote] {label} format={fmt} inputs={n_in} hidden={n_h} outputs={n_out}")
    if fmt == "legacy":
        w1 = brain.get("w1", [])
        nh = brain.get("n_hidden", 0)
        n_inputs = brain.get("n_inputs", 0)
        if n_inputs >= 16 and nh >= 1:
            FOOD_1_IDX = 2
            KILLER_IDX = 10
            food1  = [round(w1[FOOD_1_IDX  * nh + h], 3) for h in range(nh)]
            killer = [round(w1[KILLER_IDX * nh + h], 3) for h in range(nh)]
            w2 = brain.get("w2", [])
            print(f"[promote]   w1 food_1 row:  {food1}")
            print(f"[promote]   w1 killer row:  {killer}")
            print(f"[promote]   w2:             {[round(v, 3) for v in w2]}")
    elif fmt == "neat-v1":
        g = brain.get("genome", {})
        conns = g.get("connections", [])
        sample = sorted([c for c in conns if c.get("enabled", True)],
                        key=lambda c: -abs(c.get("weight", 0)))[:5]
        print(f"[promote]   {n_conn} enabled connections")
        for c in sample:
            print(f"[promote]     {c['src']:18} → {c['dst']:18} w={c['weight']:+.3f}")
    elif fmt == "hyperneat-v1":
        cppn = brain.get("cppn", {}) or {}
        cppn_h = len(cppn.get("hiddens", []))
        # Sample top-magnitude CPPN connections.
        cppn_conns = cppn.get("connections", [])
        sample = sorted([c for c in cppn_conns if c.get("enabled", True)],
                        key=lambda c: -abs(c.get("weight", 0)))[:5]
        print(f"[promote]   CPPN: {cppn_h} hidden, {n_conn} enabled connections")
        for c in sample:
            print(f"[promote]     {c['src']:14} → {c['dst']:12} w={c['weight']:+.3f}")


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results",    required=True, help="headless output JSON")
    ap.add_argument("--experiment", required=True, help="experiment JSON to patch in place")
    ap.add_argument("--rank",       type=int, default=0,
                    help="which ranked organism to promote (default 0 = top)")
    ap.add_argument("--pick-founder", action="store_true",
                    help="use founder_brains_ranked instead of living_organisms_ranked")
    ap.add_argument("--allow-anatomy-mismatch", action="store_true",
                    help="promote even if anatomy differs from experiment founder")
    ap.add_argument("--dry-run", action="store_true",
                    help="show what would change, do not write")
    args = ap.parse_args()

    results    = json.loads(Path(args.results).read_text())
    experiment = json.loads(Path(args.experiment).read_text())

    # ── pick source ─────────────────────────────────────────────────────────
    if args.pick_founder:
        pool = results.get("founder_brains_ranked", [])
        if not pool:
            sys.exit("[promote] No founder_brains_ranked in results.")
        if args.rank >= len(pool):
            sys.exit(f"[promote] Rank {args.rank} requested but only {len(pool)} founder brains available.")
        winner = pool[args.rank]
        winner_brain = winner["founder_brain"]
        winner_anatomy = None  # founders don't carry full anatomy block in this export
        print(f"[promote] Picking FOUNDER rank {args.rank}: species={winner['species']} "
              f"cum_pop={winner['cumulative_pop']} diet={winner.get('mouth_diets')} "
              f"extinct={winner['extinct']}")
    else:
        pool = results.get("living_organisms_ranked", [])
        if not pool:
            sys.exit("[promote] No living_organisms_ranked in results (population extinct?). "
                     "Try --pick-founder.")
        if args.rank >= len(pool):
            sys.exit(f"[promote] Rank {args.rank} requested but only {len(pool)} living organisms.")
        winner = pool[args.rank]
        winner_brain   = winner["brain"]
        winner_anatomy = winner.get("anatomy")
        print(f"[promote] Picking LIVING rank {args.rank}: species={winner['species']} "
              f"cum_pop={winner['species_cum_pop']} lifetime={winner['lifetime']} "
              f"food={winner['food_collected']:.2f} fitness={winner['fitness']:.4f}")

    # ── anatomy check ──────────────────────────────────────────────────────
    exp_orgs = experiment.get("organisms", [])
    if not exp_orgs:
        sys.exit("[promote] Experiment has no organisms array to patch.")
    exp_sig = anatomy_sig(exp_orgs[0]["anatomy"]["cells"])
    winner_sig = winner.get("anatomy_sig")
    if not winner_sig and winner_anatomy:
        winner_sig = anatomy_sig(winner_anatomy["cells"])

    if winner_sig and winner_sig != exp_sig:
        msg = (f"Anatomy mismatch.\n"
               f"  experiment: {exp_sig}\n"
               f"  winner:     {winner_sig}")
        if args.allow_anatomy_mismatch:
            print(f"[promote] WARNING: {msg}\n[promote] Continuing because --allow-anatomy-mismatch.")
        else:
            sys.exit(f"[promote] ERROR: {msg}\n[promote] Use --allow-anatomy-mismatch to override.")
    elif winner_sig:
        print(f"[promote] Anatomy signature matches: {exp_sig}")

    # ── shape comparison telemetry ─────────────────────────────────────────
    cur_brain = exp_orgs[0].get("brain") or {}
    print_brain_summary("CURRENT", cur_brain)
    print_brain_summary("WINNER ", winner_brain)
    cur_shape, win_shape = brain_shape(cur_brain), brain_shape(winner_brain)
    if cur_shape[:3] != win_shape[:3]:
        print(f"[promote] Brain shape changing: inputs/hidden/outputs "
              f"{cur_shape[:3]} → {win_shape[:3]}")

    # ── apply to every founder ─────────────────────────────────────────────
    for org in exp_orgs:
        org["brain"] = json.loads(json.dumps(winner_brain))  # deep copy

    # update species' founder_brain so loadRaw replays the same brain on a
    # cold start, not just a hot resume.
    species_block = experiment.get("fossil_record", {}).get("species", {})
    for name in species_block:
        species_block[name]["founder_brain"] = json.loads(json.dumps(winner_brain))

    # also bump largest_cell_count if the winner is bigger (some envs cache it
    # for renderer bounds; harmless to leave stale but cleaner to update).
    if winner_anatomy:
        experiment["largest_cell_count"] = max(
            experiment.get("largest_cell_count", 0),
            len(winner_anatomy.get("cells", [])),
        )

    print(f"[promote] Patched brain into {len(exp_orgs)} founder(s) "
          f"and {len(species_block)} species record(s).")

    if args.dry_run:
        print("[promote] --dry-run; no file written.")
        return

    Path(args.experiment).write_text(json.dumps(experiment, indent=2))
    print(f"[promote] Wrote {args.experiment}")


if __name__ == "__main__":
    main()
