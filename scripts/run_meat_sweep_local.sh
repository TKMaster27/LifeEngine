#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Local (no-scheduler) runner for the meat-nutrition sweep — for a laptop.
# Runs every variant in maps/meat_sweep/ across SEEDS with a concurrency cap.
# Output mirrors the cluster layout so analyze_meat_sweep.py just works:
#   results/<variant>/seed_<N>.json      logs/<variant>_seed_<N>.log
# No world snapshots are written (not needed for the sweep analysis).
# Already-completed seed files are skipped, so it is resume-safe.
#
# Usage:
#   bash scripts/run_meat_sweep_local.sh
#   SEEDS="1 2 3" MAX_TICKS=2000000 JOBS=6 bash scripts/run_meat_sweep_local.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.."

SEEDS="${SEEDS:-1 2}"
MAX_TICKS="${MAX_TICKS:-1500000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
JOBS="${JOBS:-4}"                 # max concurrent node processes
NODE_BIN="${NODE_BIN:-node}"

mkdir -p logs
MAPS=(maps/meat_sweep/*.json)
if [ ${#MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/meat_sweep/*.json — run scripts/generate_meat_sweep.py first."; exit 1
fi

echo "=== local meat sweep ==="
echo "variants=${#MAPS[@]}  seeds=[$SEEDS]  max_ticks=$MAX_TICKS  parallel=$JOBS"
echo "output -> results/<variant>/seed_<N>.json   logs -> logs/<variant>_seed_<N>.log"
echo ""
START=$SECONDS

run_one() {
    local MAP="$1" SEED="$2"
    local NAME; NAME="$(basename "$MAP" .json)"
    mkdir -p "results/$NAME"
    local OUT="results/$NAME/seed_$SEED.json"
    local LOG="logs/${NAME}_seed_${SEED}.log"
    if [ -f "$OUT" ]; then echo "[skip] $OUT already exists"; return 0; fi
    echo "[start] $NAME seed $SEED"
    "$NODE_BIN" src/headless.js --max-ticks "$MAX_TICKS" --load "$MAP" --seed "$SEED" \
        --data-rate "$DATA_RATE" --keep-min "$KEEP_MIN" --output "$OUT" --log-every 250000 \
        > "$LOG" 2>&1
    echo "[done ] $NAME seed $SEED (exit $?)"
}

for MAP in "${MAPS[@]}"; do
    for SEED in $SEEDS; do
        # throttle: wait until fewer than JOBS background children are running
        while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 2; done
        run_one "$MAP" "$SEED" &
    done
done
wait

ELAPSED=$((SECONDS - START))
echo ""
echo "=== all done in ${ELAPSED}s ($(printf '%dh:%02dm' $((ELAPSED/3600)) $(((ELAPSED%3600)/60)))) ==="
echo "Analyse with: uv run scripts/analyze_meat_sweep.py --plot analysis/meat_sweep.png"
