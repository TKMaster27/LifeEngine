#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Submit the random-environment sweep: patch scale x food scarcity on Perlin
# "Generate Emitters" maps. One scheduler job per map in maps/random_sweep/,
# each running N seeds in parallel. Reuses sweep.slurm / sweep.pbs
# (auto-detected), so output lands in results/<map_name>/.
#
# The full set is 3 scales x 3 scarcities x 2 noise replicates x 2 arms = 36
# jobs. That is a large single submission — use the filters to stage it:
#
#   REPLICATE=1 bash scripts/submit_random_sweep.sh    # 18 jobs: first landscape
#   REPLICATE=2 bash scripts/submit_random_sweep.sh    # 18 jobs: second landscape
#   ARM=normal  bash scripts/submit_random_sweep.sh    # 18 jobs: no predation
#   SCALE="r050" SCARCITY="e0672" bash scripts/submit_random_sweep.sh   # one cell
#
# Usage:
#   bash scripts/submit_random_sweep.sh                 # everything, 10M ticks, 5 seeds
#   SEEDS="1 2 3" MAX_TICKS=5000000 bash scripts/submit_random_sweep.sh
#   SCHEDULER=pbs bash scripts/submit_random_sweep.sh   # force scheduler
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
SCHEDULER="${SCHEDULER:-auto}"
ARM="${ARM:-both}"            # normal | predation | both
SCALE="${SCALE:-}"            # e.g. "r025 r100"  (or bare "25 100")
SCARCITY="${SCARCITY:-}"      # e.g. "e0336 e1344" (or bare "336 1344")
REPLICATE="${REPLICATE:-}"    # e.g. "1"  (or "n1")

if [ "$SCHEDULER" = "auto" ]; then
    if   command -v sbatch &>/dev/null; then SCHEDULER=slurm
    elif command -v qsub   &>/dev/null; then SCHEDULER=pbs
    else echo "ERROR: neither sbatch (SLURM) nor qsub (PBS) in PATH."; exit 1; fi
fi

ALL_MAPS=(maps/random_sweep/*.json)
if [ ${#ALL_MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/random_sweep/*.json — run"
    echo "       node scripts/generate_random_maps.js"
    exit 1
fi

# Filters accept either the tagged form (r050 / e0672 / n1) or bare numbers.
matches() {  # $1 = value from filename (e.g. r050), $2 = user filter list, $3 = tag letter
    local val="$1" list="$2" tag="$3" want
    [ -z "$list" ] && return 0
    for want in $(echo "$list" | tr ',' ' '); do
        want="${want#$tag}"
        # compare numerically so "50" matches "r050" and "336" matches "e0336"
        if [ "$((10#${val#$tag}))" -eq "$((10#$want))" ] 2>/dev/null; then return 0; fi
    done
    return 1
}

MAPS=()
for MAP in "${ALL_MAPS[@]}"; do
    BASE="$(basename "$MAP" .json)"
    case "$BASE" in
        *_predation) [ "$ARM" = "normal" ]    && continue ;;
        *)           [ "$ARM" = "predation" ] && continue ;;
    esac
    R="$(echo "$BASE" | sed -E 's/.*_(r[0-9]+)_.*/\1/')"
    E="$(echo "$BASE" | sed -E 's/.*_(e[0-9]+).*/\1/')"
    N="$(echo "$BASE" | sed -E 's/.*_(n[0-9]+).*/\1/')"
    [ "$N" = "$BASE" ] && N="n1"          # no _nN suffix => single replicate
    matches "$R" "$SCALE"     "r" || continue
    matches "$E" "$SCARCITY"  "e" || continue
    matches "$N" "$REPLICATE" "n" || continue
    MAPS+=("$MAP")
done

if [ ${#MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps matched ARM='$ARM' SCALE='$SCALE' SCARCITY='$SCARCITY' REPLICATE='$REPLICATE'."
    exit 1
fi

echo "=== random-environment sweep ==="
echo "Scheduler: $SCHEDULER   Arm: $ARM   Seeds: [$SEEDS]   Max ticks: $MAX_TICKS   Jobs: ${#MAPS[@]}"
[ -n "$SCALE$SCARCITY$REPLICATE" ] && echo "Filters: scale='$SCALE' scarcity='$SCARCITY' replicate='$REPLICATE'"
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
