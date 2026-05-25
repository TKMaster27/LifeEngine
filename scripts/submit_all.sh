#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit one PBS job per environment, each running 5 seeds in parallel.
# Edit the ENVS list to control which environments are queued.
#
# Usage:
#   bash scripts/submit_all.sh             # uses defaults below
#   SEEDS="1 2 3" bash scripts/submit_all.sh   # override seed list
#   MAX_TICKS=5000000 bash scripts/submit_all.sh   # shorter pilot sweep
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ENVS=(
    "Experiment1_Base.json"
    "experiment_2_allopatric.json"
    "experiment_3_archipelago.json"
    "Islands.json"
)

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"

cd "$(dirname "$0")/.."

for ENV in "${ENVS[@]}"; do
    if [ ! -f "$ENV" ]; then
        echo "WARN: skipping '$ENV' (file not found)"; continue
    fi
    echo "Submitting $ENV  seeds=[$SEEDS]  ticks=$MAX_TICKS"
    qsub -v "CONFIG=${ENV},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN}" \
        scripts/sweep.pbs
done

echo ""
echo "Submitted. Monitor with:  qstat -u \$USER"
