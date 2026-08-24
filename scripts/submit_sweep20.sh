#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# The 20-seed sweep: simple distance ladder + random landscapes restricted to
# mean distance to food < 100.
#
# WHY THIS SWEEP DIFFERS FROM submit_random_sweep.sh
#
#   Seeds.   20 per condition instead of 5, as requested. Submitted in BATCHES
#            of 5 (the tested resource profile: 5 tasks, 24 GB, ~810 MB/seed),
#            so one job is still 5 parallel seeds. sweep.slurm / sweep.pbs skip
#            a seed whose results/<env>/seed_<N>.json already exists, so batches
#            are idempotent and a crashed batch can simply be resubmitted.
#
#   Maps.    maps/random_near/ instead of maps/random_sweep/. In the previous
#            sweep 128 of 180 random seeds (71%) went extinct. Survival turned
#            out to track FOOD SUPPLY, not distance -- across the old fleet
#            survival by emitter level was 168 -> 3%, 336 -> 18%, 672 -> 65%,
#            and at the landscape level rho(emitters, survival) = +0.91 against
#            rho(mean distance, survival) = -0.65. So r100_e0168 sat at mean
#            distance 98 (close to food) and still lost 5/5 seeds.
#
#            The new fleet therefore gets its DISTANCE range from patch scale
#            while holding food supply high enough to survive:
#                resolutions {25, 35, 50, 100} x emitters {448, 672, 896}
#                x 2 noise fields = 24 landscapes, minus r025_e0448_n1 which
#                measured 104.0 cells and breached the < 100 requirement.
#            23 landscapes remain, spanning mean distance 27.1 .. 90.9 cells
#            (switch_cost 15 .. 74, islands 4 .. 59). Every level was chosen by
#            generating candidates and MEASURING them, not by extrapolation.
#
#   Worlds.  WORLD_SEEDS limits browser snapshots to a couple of seeds per
#            condition. They are ~23 MB each, the analysis never reads them, and
#            at 1120 runs they would otherwise add ~26 GB on their own.
#
# Usage:
#   bash scripts/submit_sweep20.sh                      # everything (264 jobs)
#   FAMILY=random bash scripts/submit_sweep20.sh        # random landscapes only
#   FAMILY=ring   bash scripts/submit_sweep20.sh        # distance ladder only
#   SEEDS_TOTAL=20 BATCH=5 bash scripts/submit_sweep20.sh
#   ARM=normal    bash scripts/submit_sweep20.sh        # skip predation siblings
#   MAX_JOBS=100  bash scripts/submit_sweep20.sh        # one wave of 100, then stop
#   DRY_RUN=1     bash scripts/submit_sweep20.sh        # print, submit nothing
#
# SUBMITTING IN WAVES. Clusters cap how many jobs one user may have queued at
# once (SLURM: AssocMaxSubmitJobLimit). 264 jobs will not go in one go. This
# script is safe to re-run: it skips any batch whose seed files already exist
# AND any batch already sitting in the queue (matched on job name), so
# re-running simply tops the queue back up. Set RESUME=0 to disable both checks.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

SEEDS_TOTAL="${SEEDS_TOTAL:-20}"
BATCH="${BATCH:-5}"                  # seeds per job == ntasks in sweep.slurm/pbs
MAX_TICKS="${MAX_TICKS:-10000000}"
DATA_RATE="${DATA_RATE:-1000}"
KEEP_MIN="${KEEP_MIN:-50}"
WORLD_SEEDS="${WORLD_SEEDS:-1 2}"    # snapshots for 2 seeds/condition, not 20
SCHEDULER="${SCHEDULER:-auto}"
FAMILY="${FAMILY:-both}"             # ring | random | both
ARM="${ARM:-both}"                   # normal | predation | both
DRY_RUN="${DRY_RUN:-}"
MAX_JOBS="${MAX_JOBS:-0}"            # 0 = no limit; else stop after N submissions
RESUME="${RESUME:-1}"                # 1 = skip batches already done or already queued

RANDOM_DIR="${RANDOM_DIR:-maps/random_near}"
RING_GLOB="${RING_GLOB:-maps/map_500_d??.json maps/map_500_d??_predation.json}"

if [ "$SCHEDULER" = "auto" ]; then
    if   command -v sbatch &>/dev/null; then SCHEDULER=slurm
    elif command -v qsub   &>/dev/null; then SCHEDULER=pbs
    elif [ -n "$DRY_RUN" ]; then SCHEDULER=slurm   # preview works off-cluster
    else echo "ERROR: neither sbatch (SLURM) nor qsub (PBS) in PATH."; exit 1; fi
fi

# ── collect maps ────────────────────────────────────────────────────────────
MAPS=()
if [ "$FAMILY" = "random" ] || [ "$FAMILY" = "both" ]; then
    FOUND=("$RANDOM_DIR"/*.json)
    if [ ${#FOUND[@]} -eq 0 ]; then
        echo "ERROR: no maps in $RANDOM_DIR — generate them with:"
        echo "  node scripts/generate_random_maps.js \\"
        echo "       --resolutions 25,35,50,100 --emitters 448,672,896 \\"
        echo "       --replicates 2 --arms both --out $RANDOM_DIR"
        echo "  rm -f $RANDOM_DIR/rand_500_r025_e0448_n1*.json   # measures 104 cells, over the <100 limit"
        exit 1
    fi
    MAPS+=("${FOUND[@]}")
fi
if [ "$FAMILY" = "ring" ] || [ "$FAMILY" = "both" ]; then
    # shellcheck disable=SC2086
    FOUND=($RING_GLOB)
    [ ${#FOUND[@]} -eq 0 ] && { echo "ERROR: no ring maps matched '$RING_GLOB'"; exit 1; }
    MAPS+=("${FOUND[@]}")
fi

# ── arm filter ──────────────────────────────────────────────────────────────
KEEP=()
for M in "${MAPS[@]}"; do
    case "$(basename "$M" .json)" in
        *_predation) [ "$ARM" = "normal" ]    && continue ;;
        *)           [ "$ARM" = "predation" ] && continue ;;
    esac
    KEEP+=("$M")
done
MAPS=("${KEEP[@]}")
[ ${#MAPS[@]} -eq 0 ] && { echo "ERROR: no maps left after ARM='$ARM'."; exit 1; }

# ── seed batches: 1..SEEDS_TOTAL chopped into runs of BATCH ─────────────────
BATCHES=()
s=1
while [ "$s" -le "$SEEDS_TOTAL" ]; do
    e=$(( s + BATCH - 1 )); [ "$e" -gt "$SEEDS_TOTAL" ] && e=$SEEDS_TOTAL
    BATCHES+=("$(seq "$s" "$e" | tr "\n" " " | sed "s/ $//")")
    s=$(( e + 1 ))
done

NJOBS=$(( ${#MAPS[@]} * ${#BATCHES[@]} ))
echo "=== 20-seed sweep ==="
echo "Scheduler:  $SCHEDULER      Family: $FAMILY      Arm: $ARM"
echo "Maps:       ${#MAPS[@]}     Seeds: 1..$SEEDS_TOTAL in ${#BATCHES[@]} batch(es) of $BATCH"
echo "Jobs:       $NJOBS          Max ticks: $MAX_TICKS   World seeds: [$WORLD_SEEDS]"
echo ""
[ -n "$DRY_RUN" ] && echo "(DRY RUN — nothing will be submitted)" && echo ""

# Names of jobs already in the queue, so a re-run tops the queue up instead of
# duplicating work. Clusters cap how many jobs one user may have queued at once
# (SLURM AssocMaxSubmitJobLimit), so finishing a large sweep NEEDS several waves.
QUEUED=""
if [ -z "$DRY_RUN" ] && [ "$RESUME" = "1" ]; then
    if [ "$SCHEDULER" = "slurm" ]; then
        QUEUED="$(squeue -u "$USER" -h -o '%j' 2>/dev/null || true)"
    else
        QUEUED="$(qstat -u "$USER" -f 2>/dev/null | awk '/Job_Name/ {print $3}' || true)"
    fi
fi

# A batch is DONE when every one of its seed files already exists. sweep.slurm /
# sweep.pbs skip such seeds anyway, but the job would still burn a queue slot.
batch_done() {
    local env="$1" seeds="$2" s
    for s in $seeds; do
        [ -f "results/${env}/seed_${s}.json" ] || return 1
    done
    return 0
}

submitted=0; skipped_done=0; skipped_queued=0
for MAP in "${MAPS[@]}"; do
    if grep -Eq '"organisms": *\[\]' "$MAP"; then
        echo "WARN: '$MAP' has no starter organisms — skipping."; continue
    fi
    ENV_NAME="$(basename "$MAP" .json)"
    for SEEDS in "${BATCHES[@]}"; do
        FIRST="${SEEDS%% *}"; LAST="${SEEDS##* }"
        JOB_NAME="ls_${ENV_NAME}_s${FIRST}-${LAST}"

        if [ "$RESUME" = "1" ] && batch_done "$ENV_NAME" "$SEEDS"; then
            skipped_done=$((skipped_done + 1)); continue
        fi
        if [ -n "$QUEUED" ] && printf '%s\n' "$QUEUED" | grep -qxF "$JOB_NAME"; then
            skipped_queued=$((skipped_queued + 1)); continue
        fi
        if [ "$MAX_JOBS" -gt 0 ] && [ "$submitted" -ge "$MAX_JOBS" ]; then
            echo ""
            echo "Reached MAX_JOBS=$MAX_JOBS — stopping here."
            echo "Re-run the same command when the queue drains; already-queued and"
            echo "already-finished batches are skipped automatically."
            break 2
        fi

        echo "  $ENV_NAME  seeds=[$SEEDS]"
        if [ -n "$DRY_RUN" ]; then submitted=$((submitted+1)); continue; fi
        if [ "$SCHEDULER" = "slurm" ]; then
            if ! CONFIG="$MAP" SEEDS="$SEEDS" MAX_TICKS="$MAX_TICKS" \
                 DATA_RATE="$DATA_RATE" KEEP_MIN="$KEEP_MIN" WORLD_SEEDS="$WORLD_SEEDS" \
                 sbatch --job-name="$JOB_NAME" scripts/sweep.slurm; then
                echo ""
                echo "sbatch refused the job after $submitted submission(s) this run."
                echo "If that was AssocMaxSubmitJobLimit you have hit the cluster's cap on"
                echo "queued jobs. Wait for some to finish, then re-run this exact command."
                break 2
            fi
        else
            if ! qsub -N "$JOB_NAME" \
                 -v "CONFIG=${MAP},SEEDS=${SEEDS},MAX_TICKS=${MAX_TICKS},DATA_RATE=${DATA_RATE},KEEP_MIN=${KEEP_MIN},WORLD_SEEDS=${WORLD_SEEDS}" \
                 scripts/sweep.pbs; then
                echo ""
                echo "qsub refused the job after $submitted submission(s) this run."
                echo "Wait for some to finish, then re-run this exact command."
                break 2
            fi
        fi
        submitted=$((submitted + 1))
    done
done

echo ""
echo "Submitted $submitted job(s)."
[ "$skipped_done" -gt 0 ]   && echo "Skipped $skipped_done batch(es) whose seed files already exist."
[ "$skipped_queued" -gt 0 ] && echo "Skipped $skipped_queued batch(es) already in the queue."
REMAIN=$(( ${#MAPS[@]} * ${#BATCHES[@]} - submitted - skipped_done - skipped_queued ))
[ "$REMAIN" -gt 0 ] && echo "Still to submit: $REMAIN — re-run this command when the queue drains."
[ "$SCHEDULER" = "slurm" ] && echo "Monitor: squeue -u \$USER" || echo "Monitor: qstat -u \$USER"
