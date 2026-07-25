#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit the meat-nutrition sweep: one scheduler job per meat-value variant in
# maps/meat_sweep/, each running N seeds in parallel. Reuses sweep.slurm /
# sweep.pbs (auto-detected), so output lands in results/<variant_name>/.
#
# Shorter tick budget than the main 10M distance sweep — we only need to observe
# emergence and early runaway onset. Killer cells appeared by ~750k ticks in the
# d07 pilot, so 3M ticks captures emergence + stabilisation with margin.
#
# Usage:
#   bash scripts/submit_meat_sweep.sh                    # 3M ticks, 5 seeds
#   SEEDS="1 2 3" MAX_TICKS=2000000 bash scripts/submit_meat_sweep.sh
#   SCHEDULER=pbs bash scripts/submit_meat_sweep.sh      # force scheduler
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-3000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
SCHEDULER="${SCHEDULER:-auto}"

if [ "$SCHEDULER" = "auto" ]; then
    if   command -v sbatch &>/dev/null; then SCHEDULER=slurm
    elif command -v qsub   &>/dev/null; then SCHEDULER=pbs
    else echo "ERROR: neither sbatch (SLURM) nor qsub (PBS) in PATH."; exit 1; fi
fi

MAPS=(maps/meat_sweep/*.json)
if [ ${#MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/meat_sweep/*.json — run scripts/generate_meat_sweep.py first."; exit 1
fi

echo "=== meat sweep ==="
echo "Scheduler: $SCHEDULER   Seeds: [$SEEDS]   Max ticks: $MAX_TICKS   Variants: ${#MAPS[@]}"
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
