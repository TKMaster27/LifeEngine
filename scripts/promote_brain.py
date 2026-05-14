#!/usr/bin/env python3
"""
promote_brain.py — swap the best-evolved brain from a headless run into an
experiment file, so the next run starts with those weights.

Iterative workflow:
    node src/headless.js --load Experiment1_Base.json --max-ticks 5000 \
                          --output results.json
    python3 scripts/promote_brain.py \
            --results results.json \
            --experiment Experiment1_Base.json
    # → Experiment1_Base.json now has the winning brain as founder.
    # → repeat.

By default picks the rank-0 organism from `living_organisms_ranked` (sorted by
species cumulative_pop, then fitness, then lifetime). Use --rank N to pick
another, or --pick-founder to promote a founder_brain from `founder_brains_ranked`
(useful when extinction killed the lineage but the founder weights were good).

The anatomy of the promoted organism must match the experiment's founder
anatomy — otherwise this would silently change the morphology you're holding
fixed. Use --allow-anatomy-mismatch to override.
"""

import argparse
import json
import sys
from pathlib import Path

def anatomy_sig(cells):
    """Compute the same anatomy signature used in headless.js."""
    parts = []
    for c in cells:
        s = f"{c['loc_col']},{c['loc_row']}:{c['state']['name']}"
        if 'diet' in c and isinstance(c['diet'], (int, float)):
            s += f"/d{int(c['diet'])}"
        if 'direction' in c and isinstance(c['direction'], (int, float)):
            s += f"/r{int(c['direction'])}"
        parts.append(s)
    return '|'.join(sorted(parts))

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--results',    required=True, help='headless output JSON')
    ap.add_argument('--experiment', required=True, help='experiment JSON to patch in place')
    ap.add_argument('--rank',       type=int, default=0, help='which ranked organism to promote (default 0 = top)')
    ap.add_argument('--pick-founder', action='store_true', help='use founder_brains_ranked instead of living_organisms_ranked')
    ap.add_argument('--allow-anatomy-mismatch', action='store_true', help='promote even if anatomy differs from experiment founder')
    ap.add_argument('--dry-run',    action='store_true', help='show what would change, do not write')
    args = ap.parse_args()

    results    = json.loads(Path(args.results).read_text())
    experiment = json.loads(Path(args.experiment).read_text())

    # ── pick source ─────────────────────────────────────────────────────────
    if args.pick_founder:
        pool = results.get('founder_brains_ranked', [])
        if not pool:
            sys.exit('No founder_brains_ranked in results.')
        if args.rank >= len(pool):
            sys.exit(f'Rank {args.rank} requested but only {len(pool)} founder brains.')
        winner = pool[args.rank]
        winner_brain   = winner['founder_brain']
        winner_anatomy = None # founders don't carry full anatomy block in this export
        print(f'[promote] Picking FOUNDER rank {args.rank}: species={winner["species"]} cum_pop={winner["cumulative_pop"]} diet={winner["mouth_diets"]} extinct={winner["extinct"]}')
    else:
        pool = results.get('living_organisms_ranked', [])
        if not pool:
            sys.exit('No living_organisms_ranked in results (population extinct?). Try --pick-founder.')
        if args.rank >= len(pool):
            sys.exit(f'Rank {args.rank} requested but only {len(pool)} living organisms.')
        winner = pool[args.rank]
        winner_brain   = winner['brain']
        winner_anatomy = winner['anatomy']
        print(f'[promote] Picking LIVING rank {args.rank}: species={winner["species"]} cum_pop={winner["species_cum_pop"]} lifetime={winner["lifetime"]} food={winner["food_collected"]:.2f} fitness={winner["fitness"]:.4f}')

    # ── anatomy check ──────────────────────────────────────────────────────
    exp_org      = experiment['organisms'][0]
    exp_sig      = anatomy_sig(exp_org['anatomy']['cells'])
    winner_sig   = winner.get('anatomy_sig') or (anatomy_sig(winner_anatomy['cells']) if winner_anatomy else None)

    if winner_sig and exp_sig != winner_sig:
        msg = (f'Anatomy mismatch.\n'
               f'  experiment: {exp_sig}\n'
               f'  winner:     {winner_sig}')
        if args.allow_anatomy_mismatch:
            print(f'[promote] WARNING: {msg}\n[promote] Continuing because --allow-anatomy-mismatch.')
        else:
            sys.exit(f'[promote] ERROR: {msg}\n[promote] Use --allow-anatomy-mismatch to override.')
    elif winner_sig:
        print(f'[promote] Anatomy signature matches: {exp_sig}')

    # ── sanity-check brain shape ───────────────────────────────────────────
    cur_brain = exp_org.get('brain', {})
    if cur_brain.get('n_inputs') != winner_brain['n_inputs'] or cur_brain.get('n_outputs') != winner_brain['n_outputs']:
        print(f'[promote] Brain shape changing: {cur_brain.get("n_inputs")}→{winner_brain["n_inputs"]} inputs,  {cur_brain.get("n_outputs")}→{winner_brain["n_outputs"]} outputs')

    # ── apply ───────────────────────────────────────────────────────────────
    exp_org['brain'] = winner_brain

    # also update the founder_brain in fossil_record so loads stay consistent
    species_block = experiment.get('fossil_record', {}).get('species', {})
    if species_block:
        # baseline has a single species — update it
        for name in species_block:
            species_block[name]['founder_brain'] = winner_brain

    print('[promote] Brain weights summary (first 5):', [round(w, 3) for w in winner_brain['weights'][:5]])
    food1_idx = 2 # food_1 feature index for the default 16-input layout
    killer_idx = 10
    n_out = winner_brain['n_outputs']
    if winner_brain['n_inputs'] >= 16 and n_out >= 1:
        print(f'[promote] food_1 weight per mover: {[round(winner_brain["weights"][food1_idx*n_out + j], 3) for j in range(n_out)]}')
        print(f'[promote] killer weight per mover: {[round(winner_brain["weights"][killer_idx*n_out + j], 3) for j in range(n_out)]}')

    if args.dry_run:
        print('[promote] --dry-run; no file written.')
        return

    Path(args.experiment).write_text(json.dumps(experiment, indent=2))
    print(f'[promote] Wrote {args.experiment}')

if __name__ == '__main__':
    main()
