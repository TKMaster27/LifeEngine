#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Standalone Linux-server sweep runner — runs one environment with N seeds.
# Same behaviour as scripts/sweep.pbs but without the PBS scheduler.
#
# Usage:
#   bash scripts/sweep.sh --config maps/map_300_close.json --seeds "1 2 3 4 5"
#   bash scripts/sweep.sh --config maps/warmup.json --seeds "0" --max-ticks 1000000
#   bash scripts/sweep.sh --config maps/map_500_far.json --seeds "1 2 3 4 5" --mode sequential
#
# To run detached so it survives SSH disconnect:
#   nohup bash scripts/sweep.sh --config maps/map_300_close.json --seeds "1 2 3 4 5" \
#       > sweep_300_close.out 2>&1 &
#   disown
#
# All seeds for one env land in results/<env_name>/seed_<N>.json. Existing
# outputs are skipped — re-running the same command resumes the missing seeds.
# ─────────────────────────────────────────────────────────────────────────────

set -u

# ─── Defaults (overridable via flags or env) ─────────────────────────────────
CONFIG="${CONFIG:-}"
SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
LOG_EVERY="${LOG_EVERY:-100000}"
MODE="${MODE:-parallel}"          # parallel | sequential
NODE_BIN="${NODE_BIN:-$(command -v node)}"

# ─── Flag parsing ────────────────────────────────────────────────────────────
print_usage() {
    sed -n '2,20p' "$0"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --config)     CONFIG="$2";     shift 2 ;;
        --seeds)      SEEDS="$2";      shift 2 ;;
        --max-ticks)  MAX_TICKS="$2";  shift 2 ;;
        --data-rate)  DATA_RATE="$2";  shift 2 ;;
        --keep-min)   KEEP_MIN="$2";   shift 2 ;;
        --log-every)  LOG_EVERY="$2";  shift 2 ;;
        --mode)       MODE="$2";       shift 2 ;;
        --node)       NODE_BIN="$2";   shift 2 ;;
        -h|--help)    print_usage; exit 0 ;;
        *) echo "ERROR: unknown flag '$1'"; print_usage; exit 2 ;;
    esac
done

# ─── Move to repo root (script lives in scripts/) ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }

# ─── Validate ────────────────────────────────────────────────────────────────
if [ -z "$CONFIG" ]; then
    echo "ERROR: --config is required"; print_usage; exit 2
fi
if [ ! -f "$CONFIG" ]; then
    echo "ERROR: Config file '$CONFIG' not found in $PROJECT_DIR"; exit 1
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Node binary not found ('$NODE_BIN'). Set --node or PATH."; exit 1
fi
case "$MODE" in
    parallel|sequential) ;;
    *) echo "ERROR: --mode must be 'parallel' or 'sequential' (got '$MODE')"; exit 2 ;;
esac

mkdir -p logs

# Stable run ID for log naming (no PBS_JOBID here). Format: YYYYMMDD-HHMMSS-PID.
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"

# ─── Run info ────────────────────────────────────────────────────────────────
echo "=== Sweep info ==="
echo "Run ID:        $RUN_ID"
echo "Host:          $(hostname)"
echo "Date:          $(date)"
echo "Node bin:      $NODE_BIN ($($NODE_BIN --version 2>/dev/null))"
echo "Config:        $CONFIG"
echo "Seeds:         $SEEDS"
echo "Max ticks:     $MAX_TICKS"
echo "Data rate:     $DATA_RATE"
echo "Keep-min:      $KEEP_MIN"
echo "Mode:          $MODE"
echo ""

ENV_NAME="$(basename "$CONFIG" .json)"
OUT_DIR="results/${ENV_NAME}"
mkdir -p "$OUT_DIR"
echo "Output dir:    $OUT_DIR"
echo ""

# ─── Per-seed runner ─────────────────────────────────────────────────────────
run_seed() {
    local SEED=$1
    local OUT="${OUT_DIR}/seed_${SEED}.json"
    local WORLD="${OUT_DIR}/seed_${SEED}_world.json"
    local SEED_LOG="logs/${ENV_NAME}_seed_${SEED}_${RUN_ID}.log"

    if [ -f "$OUT" ]; then
        echo "[seed $SEED] SKIP — $OUT already exists"
        return 0
    fi

    echo "[seed $SEED] start → $OUT (log: $SEED_LOG)"
    "$NODE_BIN" src/headless.js \
        --max-ticks "$MAX_TICKS" \
        --load      "$CONFIG" \
        --seed      "$SEED" \
        --data-rate "$DATA_RATE" \
        --keep-min  "$KEEP_MIN" \
        --output    "$OUT" \
        --save-world "$WORLD" \
        --log-every "$LOG_EVERY" \
        > "$SEED_LOG" 2>&1
    local EC=$?
    if [ $EC -eq 0 ]; then
        echo "[seed $SEED] DONE — $OUT"
    else
        echo "[seed $SEED] FAILED with exit code $EC — see $SEED_LOG"
    fi
    return $EC
}

# Make sure Ctrl-C kills any in-flight node processes too, not just this shell.
cleanup() {
    echo ""
    echo "=== Interrupted — terminating background seeds ==="
    pkill -P $$ 2>/dev/null
    exit 130
}
trap cleanup INT TERM

# ─── Dispatch ────────────────────────────────────────────────────────────────
echo "=== Starting sweep ($MODE) ==="
echo ""
START=$SECONDS
PIDS=()
FAILED=0

if [ "$MODE" = "parallel" ]; then
    for S in $SEEDS; do
        run_seed "$S" &
        PIDS+=($!)
    done
    for PID in "${PIDS[@]}"; do
        if ! wait "$PID"; then FAILED=$((FAILED + 1)); fi
    done
else
    for S in $SEEDS; do
        if ! run_seed "$S"; then FAILED=$((FAILED + 1)); fi
    done
fi

ELAPSED=$((SECONDS - START))
echo ""
echo "=== Sweep finished ==="
echo "Elapsed: ${ELAPSED}s  ($(printf '%dh:%02dm' $((ELAPSED/3600)) $(((ELAPSED%3600)/60))))"
echo "Failed seeds: $FAILED"
echo "Date: $(date)"

exit $FAILED
