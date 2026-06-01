#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit one PBS job per cluster-spacing experiment map, each running 5 seeds
# in parallel. Submits 9 jobs total (3 sizes × 3 distance levels).
#
# Each map MUST contain a starting organism — generate_maps.py produces empty
# templates; drop a starter organism in the browser editor and re-save before
# submitting.
#
# Usage:
#   bash scripts/submit_all_maps.sh                   # full sweep, 10M ticks, 5 seeds
#   SEEDS="1 2 3" bash scripts/submit_all_maps.sh     # subset of seeds
#   MAX_TICKS=1000000 bash scripts/submit_all_maps.sh # short pilot sweep
#   ONLY=300 bash scripts/submit_all_maps.sh          # only one map size
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SIZES=(100 300 500)
DISTANCES=(close medium far)

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
ONLY="${ONLY:-}"      # set to 100, 300, or 500 to filter

cd "$(dirname "$0")/.."

for SIZE in "${SIZES[@]}"; do
    if [ -n "$ONLY" ] && [ "$ONLY" != "$SIZE" ]; then continue; fi
    for DIST in "${DISTANCES[@]}"; do
        MAP="maps/map_${SIZE}_${DIST}.json"
        if [ ! -f "$MAP" ]; then
            echo "WARN: skipping '$MAP' (file not found — run generate_maps.py?)"; continue
        fi
        echo "Submitting $MAP  seeds=[$SEEDS]  ticks=$MAX_TICKS"
        qsub -v "CONFIG=${MAP},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN}" \
            scripts/sweep.pbs
    done
done

echo ""
echo "Submitted. Monitor with:  qstat -u \$USER"
