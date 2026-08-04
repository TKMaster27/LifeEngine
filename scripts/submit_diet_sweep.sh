#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit the diet-penalty sweep: one scheduler job per variant in
# maps/diet_sweep/, each running N seeds in parallel. Reuses sweep.slurm /
# sweep.pbs (auto-detected), so output lands in results/<variant_name>/.
#
# Full 10M-tick runs (same budget as the distance sweep) — diet composition kept
# shifting past 2M in the validation runs, and the extinction outcome in the
# predation arm only shows up over a long horizon.
#
# Usage:
#   bash scripts/submit_diet_sweep.sh                       # both arms, 10M ticks, 5 seeds
#   ARM=predation bash scripts/submit_diet_sweep.sh         # predation arm only
#   ONLY="p000 p200" bash scripts/submit_diet_sweep.sh      # only these penalty levels
#   SEEDS="1 2 3" MAX_TICKS=4000000 bash scripts/submit_diet_sweep.sh
#   SCHEDULER=pbs bash scripts/submit_diet_sweep.sh         # force scheduler
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
SCHEDULER="${SCHEDULER:-auto}"
ARM="${ARM:-both}"          # normal | predation | both
ONLY="${ONLY:-}"            # e.g. "p000 p200" or "000 200"

if [ "$SCHEDULER" = "auto" ]; then
    if   command -v sbatch &>/dev/null; then SCHEDULER=slurm
    elif command -v qsub   &>/dev/null; then SCHEDULER=pbs
    else echo "ERROR: neither sbatch (SLURM) nor qsub (PBS) in PATH."; exit 1; fi
fi

ALL_MAPS=(maps/diet_sweep/*.json)
if [ ${#ALL_MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/diet_sweep/*.json — run scripts/generate_diet_sweep.py first."; exit 1
fi

# Filter by arm (predation maps carry '_predation' in the filename) and by
# penalty level (ONLY accepts 'p000'/'000', space- or comma-separated).
ONLY_NORM="$(echo "$ONLY" | tr ',' ' ')"
MAPS=()
for MAP in "${ALL_MAPS[@]}"; do
    case "$MAP" in
        *_predation_*) [ "$ARM" = "normal" ]    && continue ;;
        *)             [ "$ARM" = "predation" ] && continue ;;
    esac
    if [ -n "$ONLY_NORM" ]; then
        LEVEL="$(basename "$MAP" .json | sed -E 's/.*_diet(p[0-9]+).*/\1/')"
        keep=0
        for want in $ONLY_NORM; do
            [ "${want#p}" = "${LEVEL#p}" ] && keep=1
        done
        [ "$keep" -eq 1 ] || continue
    fi
    MAPS+=("$MAP")
done

if [ ${#MAPS[@]} -eq 0 ]; then
    echo "ERROR: no variants matched ARM='$ARM' ONLY='$ONLY'."; exit 1
fi

echo "=== diet-penalty sweep ==="
echo "Scheduler: $SCHEDULER   Arm: $ARM   Seeds: [$SEEDS]   Max ticks: $MAX_TICKS   Variants: ${#MAPS[@]}"
echo ""

submitted=0
for MAP in "${MAPS[@]}"; do
    if grep -Eq '"organisms": *\[\]' "$MAP"; then
        echo "WARN: '$MAP' has no starter organisms — skipping."; continue
    fi
    echo "Submitting $MAP  seeds=[$SEEDS]  ticks=$MAX_TICKS"
    if [ "$SCHEDULER" = "slurm" ]; then
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
[ "$SCHEDULER" = "slurm" ] && echo "Monitor: squeue -u \$USER" || echo "Monitor: qstat -u \$USER"
