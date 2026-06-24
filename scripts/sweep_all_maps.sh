#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Standalone Linux-server runner for the 500×500 cluster-spacing maps × N seeds.
# Maps are discovered from disk (maps/map_500_d*.json), so the sweep adapts to
# however many distance levels generate_maps.py produced (default d01…d10).
# Runs every (map, seed) pair as an independent node process, bounded by
# MAX_PARALLEL concurrent jobs.
#
# Defaults to MAX_PARALLEL = $(nproc) — uses every core. On a shared
# server, set MAX_PARALLEL to leave headroom for other users (e.g. half the
# core count, or whatever you've agreed with sysadmin).
#
# Usage:
#   bash scripts/sweep_all_maps.sh                         # full sweep, all cores
#   MAX_PARALLEL=8 bash scripts/sweep_all_maps.sh          # cap at 8 concurrent
#   SEEDS="1 2 3" bash scripts/sweep_all_maps.sh           # subset of seeds
#   MAX_TICKS=1000000 bash scripts/sweep_all_maps.sh       # pilot sweep
#   ONLY="d01 d05" bash scripts/sweep_all_maps.sh          # only these distance levels
#   VARIANT=predation bash scripts/sweep_all_maps.sh       # sweep predation maps only
#   VARIANT=both bash scripts/sweep_all_maps.sh            # both normal and predation
#
# Map variants — which set of maps is swept:
#   VARIANT=normal     (default)  → maps/map_500_dNN.json
#   VARIANT=predation             → maps/map_500_dNN_predation.json
#   VARIANT=both                  → both sets (doubles the workload)
#
# Each map MUST contain a starting organism (dropped in via the browser editor
# and saved back to the same filename). Maps with an empty "organisms" array are
# warned-and-skipped (they would extinct at tick 1).
#
# In tmux (survives SSH disconnect):
#   tmux new -s sweep
#   bash scripts/sweep_all_maps.sh
#   Ctrl-b d                                               # detach
#   # later:
#   tmux attach -t sweep
#
# Outputs are split into two parallel folders:
#   results/<env_name>/seed_<N>.json        — tracked simulation stats
#   worlds/<env_name>/seed_<N>_world.json   — browser-loadable world snapshot
# The env_name is taken from the map filename so predation runs are easy to
# identify at a glance (e.g. results/map_500_d05_predation/seed_3.json).
#
# Resumable: existing results/<env>/seed_<N>.json files are skipped so a
# re-run picks up where it left off.
# ─────────────────────────────────────────────────────────────────────────────

set -u
shopt -s nullglob

# Bounded-concurrency dispatch uses `wait -n`, which needs bash >= 4.3 (2014).
# Modern Linux has this; macOS does not (Apple ships bash 3.2).
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ] \
   || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -lt 3 ]; }; then
    echo "ERROR: This script requires bash >= 4.3 (for 'wait -n')."
    echo "       Found: $BASH_VERSION"
    echo "       On macOS: brew install bash, then run with /opt/homebrew/bin/bash."
    exit 1
fi

SEEDS="${SEEDS:-1 2 3 4 5}"
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
LOG_EVERY="${LOG_EVERY:-100000}"
ONLY="${ONLY:-}"
VARIANT="${VARIANT:-normal}"      # normal | predation | both
NODE_BIN="${NODE_BIN:-$(command -v node)}"
MAX_PARALLEL="${MAX_PARALLEL:-$(nproc 2>/dev/null || echo 4)}"

case "$VARIANT" in
    normal|predation|both) ;;
    *) echo "ERROR: VARIANT must be 'normal', 'predation', or 'both' (got '$VARIANT')"; exit 2 ;;
esac

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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Node binary not found ('$NODE_BIN'). Set NODE_BIN or PATH."; exit 1
fi

mkdir -p logs results worlds
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"

# ─── Discover maps from disk and split into normal vs predation ──────────────
ALL_MAPS=(maps/map_500_d*.json)
if [ ${#ALL_MAPS[@]} -eq 0 ]; then
    echo "ERROR: no maps/map_500_d*.json maps found — run generate_maps.py first."; exit 1
fi

MAPS=()
for m in "${ALL_MAPS[@]}"; do
    case "$m" in
        *_predation.json) [ "$VARIANT" = "predation" ] || [ "$VARIANT" = "both" ] && MAPS+=("$m") ;;
        *)                [ "$VARIANT" = "normal" ]    || [ "$VARIANT" = "both" ] && MAPS+=("$m") ;;
    esac
done

# ─── Enumerate (map, seed) work items, skipping existing outputs ─────────────
declare -a WORK
SKIPPED=0
for MAP in "${MAPS[@]}"; do
    label=""
    if [[ "$MAP" =~ map_500_(d[0-9]+) ]]; then label="${BASH_REMATCH[1]}"; fi
    if ! label_selected "$label"; then continue; fi
    if [ ! -f "$MAP" ]; then
        echo "WARN: skipping '$MAP' (file not found)"; continue
    fi
    if grep -Eq '"organisms": *\[\]' "$MAP"; then
        echo "WARN: '$MAP' has an empty organisms array — add a starting organism before running. Skipping."
        continue
    fi
    ENV_NAME="$(basename "$MAP" .json)"
    mkdir -p "results/$ENV_NAME" "worlds/$ENV_NAME"
    for S in $SEEDS; do
        OUT="results/$ENV_NAME/seed_${S}.json"
        if [ -f "$OUT" ]; then
            SKIPPED=$((SKIPPED + 1)); continue
        fi
        WORK+=("$MAP|$ENV_NAME|$S")
    done
done

TOTAL=${#WORK[@]}
NCPU=$(nproc 2>/dev/null || echo '?')

echo "=== sweep_all_maps ==="
echo "Run ID:        $RUN_ID"
echo "Host:          $(hostname)  ($NCPU cores)"
echo "Node:          $NODE_BIN ($($NODE_BIN --version 2>/dev/null))"
echo "Variant:       $VARIANT"
[ -n "$ONLY" ] && echo "Only:          $ONLY"
echo "Total runs:    $TOTAL  (skipped $SKIPPED already-complete)"
echo "Max parallel:  $MAX_PARALLEL"
echo "Max ticks:     $MAX_TICKS"
echo "Seeds:         $SEEDS"
echo "Data rate:     $DATA_RATE"
echo "Keep-min:      $KEEP_MIN"
echo ""

if [ $TOTAL -eq 0 ]; then
    echo "Nothing to do — every target already complete."
    exit 0
fi

# ─── Per-(map, seed) runner ──────────────────────────────────────────────────
run_one() {
    local MAP=$1 ENV_NAME=$2 SEED=$3
    local OUT="results/$ENV_NAME/seed_${SEED}.json"
    local WORLD="worlds/$ENV_NAME/seed_${SEED}_world.json"
    local LOG="logs/${ENV_NAME}_seed_${SEED}_${RUN_ID}.log"

    local T0=$SECONDS
    "$NODE_BIN" src/headless.js \
        --max-ticks "$MAX_TICKS" \
        --load      "$MAP" \
        --seed      "$SEED" \
        --data-rate "$DATA_RATE" \
        --keep-min  "$KEEP_MIN" \
        --output    "$OUT" \
        --save-world "$WORLD" \
        --log-every "$LOG_EVERY" \
        > "$LOG" 2>&1
    local EC=$?
    local DT=$((SECONDS - T0))
    if [ $EC -eq 0 ]; then
        echo "[done ] $ENV_NAME seed=$SEED  (${DT}s)"
    else
        echo "[FAIL ] $ENV_NAME seed=$SEED  (EC=$EC, ${DT}s) — see $LOG"
    fi
    return $EC
}

# Kill in-flight jobs on Ctrl-C
trap 'echo; echo "interrupted — terminating background jobs"; pkill -P $$ 2>/dev/null; exit 130' INT TERM

# ─── Dispatch with bounded concurrency ───────────────────────────────────────
OVERALL_START=$SECONDS
RUNNING=0
FAILED=0
LAUNCHED=0

for ITEM in "${WORK[@]}"; do
    IFS='|' read -r MAP ENV_NAME SEED <<< "$ITEM"

    # Block until there's a free slot
    while [ $RUNNING -ge $MAX_PARALLEL ]; do
        if ! wait -n; then FAILED=$((FAILED + 1)); fi
        RUNNING=$((RUNNING - 1))
    done

    LAUNCHED=$((LAUNCHED + 1))
    echo "[start] $ENV_NAME seed=$SEED   ($LAUNCHED/$TOTAL queued, $RUNNING running)"
    run_one "$MAP" "$ENV_NAME" "$SEED" &
    RUNNING=$((RUNNING + 1))
done

# Drain remaining jobs
while [ $RUNNING -gt 0 ]; do
    if ! wait -n; then FAILED=$((FAILED + 1)); fi
    RUNNING=$((RUNNING - 1))
done

ELAPSED=$((SECONDS - OVERALL_START))
echo ""
echo "=== sweep_all_maps finished ==="
echo "Launched: $LAUNCHED   Failed: $FAILED   Skipped (already done): $SKIPPED"
echo "Elapsed:  ${ELAPSED}s  ($(printf '%dh:%02dm' $((ELAPSED/3600)) $(((ELAPSED%3600)/60))))"
echo "Date:     $(date)"

exit $FAILED
