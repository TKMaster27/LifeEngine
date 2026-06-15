#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit one scheduler job per cluster-spacing experiment map, each running 5
# seeds in parallel. Submits 9 jobs by default (3 sizes × 3 distance levels),
# or 18 with VARIANT=both.
#
# Supports both PBS (CHPC, qsub) and SLURM (UCT HPC, sbatch).
# The scheduler is auto-detected from PATH, or forced with SCHEDULER=pbs|slurm.
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
#   SCHEDULER=slurm bash scripts/submit_all_maps.sh       # force SLURM even if both are in PATH
#   SCHEDULER=pbs bash scripts/submit_all_maps.sh         # force PBS
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
SCHEDULER="${SCHEDULER:-auto}"  # auto | pbs | slurm

case "$VARIANT" in
    normal|predation|both) ;;
    *) echo "ERROR: VARIANT must be 'normal', 'predation', or 'both' (got '$VARIANT')"; exit 2 ;;
esac

case "$SCHEDULER" in
    auto|pbs|slurm) ;;
    *) echo "ERROR: SCHEDULER must be 'auto', 'pbs', or 'slurm' (got '$SCHEDULER')"; exit 2 ;;
esac

# Auto-detect scheduler from PATH
if [ "$SCHEDULER" = "auto" ]; then
    if command -v sbatch &>/dev/null; then
        SCHEDULER=slurm
    elif command -v qsub &>/dev/null; then
        SCHEDULER=pbs
    else
        echo "ERROR: Neither 'sbatch' (SLURM) nor 'qsub' (PBS) found in PATH."
        echo "       Set SCHEDULER=slurm or SCHEDULER=pbs, or load the appropriate module."
        exit 1
    fi
fi

# Build list of suffixes to submit based on VARIANT
SUFFIXES=()
if [ "$VARIANT" = "normal" ]    || [ "$VARIANT" = "both" ]; then SUFFIXES+=("_V1"); fi
if [ "$VARIANT" = "predation" ] || [ "$VARIANT" = "both" ]; then SUFFIXES+=("_V1_predation"); fi

cd "$(dirname "$0")/.."

echo "=== submit_all_maps ==="
echo "Scheduler:  $SCHEDULER"
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
            echo "Submitting $MAP  seeds=[$SEEDS]  ticks=$MAX_TICKS  scheduler=$SCHEDULER"
            if [ "$SCHEDULER" = "slurm" ]; then
                # Export variables into the job environment; SEEDS may contain
                # spaces so we set them before sbatch rather than via --export=.
                CONFIG="$MAP" SEEDS="$SEEDS" MAX_TICKS="$MAX_TICKS" \
                DATA_RATE="$DATA_RATE" KEEP_MIN="$KEEP_MIN" \
                sbatch scripts/sweep.slurm
            else
                qsub -v "CONFIG=${MAP},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN}" \
                    scripts/sweep.pbs
            fi
        done
    done
done

echo ""
if [ "$SCHEDULER" = "slurm" ]; then
    echo "Submitted. Monitor with:  squeue -u \$USER"
    echo "Cancel a job with:        scancel <JOBID>"
else
    echo "Submitted. Monitor with:  qstat -u \$USER"
    echo "Cancel a job with:        qdel <JOBID>"
fi
