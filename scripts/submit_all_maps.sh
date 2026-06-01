#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit one PBS job per cluster-spacing experiment map, each running 5 seeds
# in parallel. Submits 9 jobs by default (3 sizes × 3 distance levels), or 18
# with VARIANT=both.
#
# Each map MUST contain a starting organism — the _V1 maps are the starter-
# organism variants. Re-generate with generate_maps.py + drop a starter via
# the browser editor + save back to the _V1 filename if you regenerate.
#
# Usage:
#   bash scripts/submit_all_maps.sh                       # full sweep, 10M ticks, 5 seeds, normal maps
#   SEEDS="1 2 3" bash scripts/submit_all_maps.sh         # subset of seeds
#   MAX_TICKS=1000000 bash scripts/submit_all_maps.sh     # short pilot sweep
#   ONLY=300 bash scripts/submit_all_maps.sh              # only one map size
#   VARIANT=predation bash scripts/submit_all_maps.sh     # only predation (deadTurnToFood=true) maps
#   VARIANT=both bash scripts/submit_all_maps.sh          # both normal and predation (2× jobs)
#
# Map variants — which set of starter-organism maps is submitted:
#   VARIANT=normal     (default)  → maps/map_<size>_<dist>_V1.json
#   VARIANT=predation             → maps/map_<size>_<dist>_V1_predation.json
#   VARIANT=both                  → both sets (doubles the workload)
#
# The env_name is taken from the map filename so predation runs are easy to
# identify at a glance — outputs land in:
#   results/<env_name>/seed_<N>.json        (tracked simulation stats)
#   worlds/<env_name>/seed_<N>_world.json   (browser-loadable world snapshot)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SIZES=(100 300 500)
DISTANCES=(close medium far)

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
ONLY="${ONLY:-}"                # set to 100, 300, or 500 to filter
VARIANT="${VARIANT:-normal}"    # normal | predation | both

case "$VARIANT" in
    normal|predation|both) ;;
    *) echo "ERROR: VARIANT must be 'normal', 'predation', or 'both' (got '$VARIANT')"; exit 2 ;;
esac

# Build list of suffixes to submit based on VARIANT
SUFFIXES=()
if [ "$VARIANT" = "normal" ]    || [ "$VARIANT" = "both" ]; then SUFFIXES+=("_V1"); fi
if [ "$VARIANT" = "predation" ] || [ "$VARIANT" = "both" ]; then SUFFIXES+=("_V1_predation"); fi

cd "$(dirname "$0")/.."

echo "=== submit_all_maps ==="
echo "Variant:    $VARIANT  (map suffixes: ${SUFFIXES[*]})"
echo "Seeds:      $SEEDS"
echo "Max ticks:  $MAX_TICKS"
echo ""

for SIZE in "${SIZES[@]}"; do
    if [ -n "$ONLY" ] && [ "$ONLY" != "$SIZE" ]; then continue; fi
    for DIST in "${DISTANCES[@]}"; do
        for SUF in "${SUFFIXES[@]}"; do
            MAP="maps/map_${SIZE}_${DIST}${SUF}.json"
            if [ ! -f "$MAP" ]; then
                echo "WARN: skipping '$MAP' (file not found — run generate_maps.py / duplicate_maps_predation.py?)"; continue
            fi
            echo "Submitting $MAP  seeds=[$SEEDS]  ticks=$MAX_TICKS"
            qsub -v "CONFIG=${MAP},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN}" \
                scripts/sweep.pbs
        done
    done
done

echo ""
echo "Submitted. Monitor with:  qstat -u \$USER"
