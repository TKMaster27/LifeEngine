#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit one scheduler job per 500×500 cluster-spacing map, each running 5 seeds
# in parallel. Maps are discovered from disk (maps/map_500_d*.json), so the
# sweep automatically adapts to however many distance levels generate_maps.py
# produced (default d01…d10).
#
# Supports both PBS (CHPC, qsub) and SLURM (UCT HPC, sbatch).
# The scheduler is auto-detected from PATH, or forced with SCHEDULER=pbs|slurm.
#
# Each map MUST contain a starting organism — drop one in via the browser editor
# and save back to the same filename before submitting. Maps with an empty
# "organisms" array are flagged with a warning (they would extinct at tick 1).
#
# Usage:
#   bash scripts/submit_all_maps.sh                       # all maps, 10M ticks, 5 seeds, normal variant
#   SEEDS="1 2 3" bash scripts/submit_all_maps.sh         # subset of seeds
#   MAX_TICKS=1000000 bash scripts/submit_all_maps.sh     # short pilot sweep
#   ONLY="d01 d05" bash scripts/submit_all_maps.sh        # only these distance levels
#   VARIANT=predation bash scripts/submit_all_maps.sh     # only predation (deadTurnToFood=true) maps
#   VARIANT=both bash scripts/submit_all_maps.sh          # both normal and predation (2× jobs)
#   SCHEDULER=slurm bash scripts/submit_all_maps.sh       # force SLURM even if both are in PATH
#   SCHEDULER=pbs bash scripts/submit_all_maps.sh         # force PBS
#
# Map variants — which set of maps is submitted:
#   VARIANT=normal     (default)  → maps/map_500_dNN.json
#   VARIANT=predation             → maps/map_500_dNN_predation.json
#   VARIANT=both                  → both sets (doubles the workload)
#
# The env_name is taken from the map filename so predation runs are easy to
# identify at a glance — outputs land in:
#   results/<env_name>/seed_<N>.json        (tracked simulation stats)
#   worlds/<env_name>/seed_<N>_world.json   (browser-loadable world snapshot)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
shopt -s nullglob

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
ONLY="${ONLY:-}"                # space/comma-separated distance labels, e.g. "d01 d05"
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

cd "$(dirname "$0")/.."

# Discover maps from disk and split into normal vs predation.
ALL_MAPS=(maps/map_500_d*.json)
if [ ${#ALL_MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/map_500_d*.json maps found — run generate_maps.py first."; exit 1
fi

NORMAL_MAPS=()
PREDATION_MAPS=()
for m in "${ALL_MAPS[@]}"; do
    case "$m" in
        *_predation.json) PREDATION_MAPS+=("$m") ;;
        *)                NORMAL_MAPS+=("$m") ;;
    esac
done

# Build the submission list based on VARIANT.
MAPS=()
if [ "$VARIANT" = "normal" ]    || [ "$VARIANT" = "both" ]; then MAPS+=("${NORMAL_MAPS[@]}"); fi
if [ "$VARIANT" = "predation" ] || [ "$VARIANT" = "both" ]; then MAPS+=("${PREDATION_MAPS[@]}"); fi

# Normalise the ONLY filter (commas → spaces) into a lookup set of labels.
ONLY="${ONLY//,/ }"

# Does this map's distance label pass the ONLY filter? (empty ONLY = keep all)
label_selected() {
    local label="$1"
    [ -z "$ONLY" ] && return 0
    local tok num="${label#d}"; num="${num#0}"   # d05 → 5 for numeric matches
    for tok in $ONLY; do
        local tnum="${tok#d}"; tnum="${tnum#0}"
        if [ "$tok" = "$label" ] || [ "$tnum" = "$num" ]; then return 0; fi
    done
    return 1
}

echo "=== submit_all_maps ==="
echo "Scheduler:  $SCHEDULER"
echo "Variant:    $VARIANT"
echo "Seeds:      $SEEDS"
echo "Max ticks:  $MAX_TICKS"
[ -n "$ONLY" ] && echo "Only:       $ONLY"
echo ""

submitted=0
for MAP in "${MAPS[@]}"; do
    # Extract the distance label (d01, d02, …) for the ONLY filter.
    label=""
    if [[ "$MAP" =~ map_500_(d[0-9]+) ]]; then label="${BASH_REMATCH[1]}"; fi
    if ! label_selected "$label"; then continue; fi

    if [ ! -f "$MAP" ]; then
        echo "WARN: skipping '$MAP' (file not found)"; continue
    fi
    # Footgun guard: a map with no starting organism extincts at tick 1.
    if grep -Eq '"organisms": *\[\]' "$MAP"; then
        echo "WARN: '$MAP' has an empty organisms array — add a starting organism before running. Skipping."
        continue
    fi

    echo "Submitting $MAP  seeds=[$SEEDS]  ticks=$MAX_TICKS  scheduler=$SCHEDULER"
    if [ "$SCHEDULER" = "slurm" ]; then
        # Export variables into the job environment; SEEDS may contain spaces so
        # we set them before sbatch rather than via --export=.
        CONFIG="$MAP" SEEDS="$SEEDS" MAX_TICKS="$MAX_TICKS" \
        DATA_RATE="$DATA_RATE" KEEP_MIN="$KEEP_MIN" \
        sbatch scripts/sweep.slurm
    else
        qsub -v "CONFIG=${MAP},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN}" \
            scripts/sweep.pbs
    fi
    submitted=$((submitted + 1))
done

echo ""
echo "Submitted $submitted job(s)."
if [ "$SCHEDULER" = "slurm" ]; then
    echo "Monitor with:  squeue -u \$USER"
    echo "Cancel a job with:  scancel <JOBID>"
else
    echo "Monitor with:  qstat -u \$USER"
    echo "Cancel a job with:  qdel <JOBID>"
fi
