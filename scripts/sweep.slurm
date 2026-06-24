#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SLURM script — runs one environment with N seeds in PARALLEL.
# Equivalent to scripts/sweep.pbs but for SLURM-managed clusters (e.g. UCT HPC).
#
# Usage (one job per environment):
#   sbatch --export=ALL,CONFIG=maps/map_500_d05.json scripts/sweep.slurm
#   sbatch --export=ALL,CONFIG=maps/map_500_d05.json,SEEDS="1 2 3 4 5",MAX_TICKS=10000000 scripts/sweep.slurm
#
# Or export variables first (equivalent, avoids quoting issues with spaces):
#   CONFIG=maps/map_500_d05.json SEEDS="1 2 3 4 5" sbatch scripts/sweep.slurm
#
# To run sequentially instead of in parallel (e.g. if you only have 1 core):
#   sbatch --export=ALL,CONFIG=maps/map_500_d05.json,MODE=sequential scripts/sweep.slurm
#   (also change --ntasks=1 below)
#
# The submit_all_maps.sh script calls this automatically when SLURM is detected.
#
# Outputs are split into two parallel folders:
#   results/<env_name>/seed_<N>.json          — tracked simulation stats (analysis)
#   worlds/<env_name>/seed_<N>_world.json     — browser-loadable end-of-run snapshot
# Predation maps (controls.deadTurnToFood=true) naturally land in their own
# env folder because the env_name is derived from the map filename — e.g.
# results/map_500_d05_predation/seed_1.json. Existing outputs are
# skipped so re-submitting after a crash resumes the remaining seeds.
# ─────────────────────────────────────────────────────────────────────────────

#SBATCH --job-name="life_sweep"
#SBATCH --account=compsci
#SBATCH --partition=ada
#SBATCH --nodes=1
#SBATCH --ntasks=5
#SBATCH --mem=24G
#SBATCH --time=48:00:00
#SBATCH --output=logs/sweep_%j.out
#SBATCH --error=logs/sweep_%j.err
#SBATCH --mail-user=mcktar010@myuct.ac.za
#SBATCH --mail-type=BEGIN,END,FAIL
#SBATCH --export=ALL

# ─── Defaults (overridable via --export or environment variables at sbatch time) ──
: "${CONFIG:?must set CONFIG=<env.json> before sbatch, or use --export=ALL,CONFIG=...}"
: "${SEEDS:=1 2 3 4 5}"
: "${MAX_TICKS:=10000000}"
: "${DATA_RATE:=1000}"
: "${KEEP_MIN:=50}"
: "${LOG_EVERY:=100000}"
: "${MODE:=parallel}"             # parallel | sequential

# ─── Paths (edit these to match your home directory on this cluster) ─────────
# If nvm is set up, source it so 'node' is in PATH.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Resolve node binary: prefer NVM-managed node, fall back to PATH.
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null)}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/LifeEngine}"

# ─── Job info ────────────────────────────────────────────────────────────────
echo "=== Job info ==="
echo "Job ID:        $SLURM_JOB_ID"
echo "Node:          $(hostname)"
echo "Date:          $(date)"
echo "Node bin:      $NODE_BIN ($($NODE_BIN --version 2>/dev/null || echo 'not found'))"
echo "Config:        $CONFIG"
echo "Seeds:         $SEEDS"
echo "Max ticks:     $MAX_TICKS"
echo "Data rate:     $DATA_RATE"
echo "Keep-min:      $KEEP_MIN"
echo "Mode:          $MODE"
echo ""

cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }
mkdir -p logs

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Node binary not found ('${NODE_BIN:-<empty>}')."
    echo "       Install Node via nvm (nvm install 16) or set NODE_BIN in your environment."
    exit 1
fi
if [ ! -f "$CONFIG" ]; then
    echo "ERROR: Config file '$CONFIG' not found in $PROJECT_DIR"; exit 1
fi

# Derive a clean env name from the config file (strip path + .json).
# Predation variants (filename ends in _predation) automatically get a
# separate env folder, so results are easy to identify at a glance.
ENV_NAME="$(basename "$CONFIG" .json)"
RESULTS_DIR="results/${ENV_NAME}"
WORLDS_DIR="worlds/${ENV_NAME}"
mkdir -p "$RESULTS_DIR" "$WORLDS_DIR"
echo "Results dir:   $RESULTS_DIR"
echo "Worlds dir:    $WORLDS_DIR"
echo ""

# ─── Per-seed runner ─────────────────────────────────────────────────────────
run_seed() {
    local SEED=$1
    local OUT="${RESULTS_DIR}/seed_${SEED}.json"
    local WORLD="${WORLDS_DIR}/seed_${SEED}_world.json"
    local SEED_LOG="logs/${ENV_NAME}_seed_${SEED}_${SLURM_JOB_ID}.log"

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

# Exit non-zero if anything failed, so SLURM marks the job accordingly
exit $FAILED
