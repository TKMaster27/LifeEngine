#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Run scripts/analyze_results.py on every results/*/seed_*.json found.
# Each run's plots land in analysis/<env_name>__seed_<N>/.
#
# Usage:
#   bash scripts/analyze_all.sh                  # analyse everything new
#   bash scripts/analyze_all.sh --force          # re-analyse even if output exists
#   bash scripts/analyze_all.sh --only d05       # only results whose path matches 'd05'
#
# Resumable: skips a run whose summary.png already exists, unless --force.
# Prints a one-line summary (extinction tick, final pop, final species) per run.
# ─────────────────────────────────────────────────────────────────────────────

set -u

FORCE=0
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --force)  FORCE=1; shift ;;
        --only)   ONLY="$2"; shift 2 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "ERROR: unknown flag '$1'"; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }

if [ ! -d results ]; then
    echo "ERROR: no results/ directory found in $PROJECT_DIR"; exit 1
fi

mkdir -p analysis

# Find every seed_*.json that isn't a world snapshot. Use a temp file rather
# than `mapfile` so this also runs on bash 3.x.
TMP_LIST="$(mktemp)"
trap 'rm -f "$TMP_LIST"' EXIT
find results -type f -name 'seed_*.json' ! -name '*_world.json' | sort > "$TMP_LIST"

TOTAL=$(wc -l < "$TMP_LIST")
if [ "$TOTAL" -eq 0 ]; then
    echo "Nothing to analyse — results/ is empty."
    exit 0
fi
DONE=0
SKIPPED=0
FAILED=0
EXTINCT=0
SURVIVED=0

echo "=== analyze_all ==="
echo "Found $TOTAL result file(s) in results/"
[ -n "$ONLY" ] && echo "Filter: only files matching '$ONLY'"
echo ""

printf "%-50s %12s %10s %10s\n" "RUN" "ext_tick" "final_pop" "species"
printf -- '%.0s-' {1..90}; echo

while IFS= read -r f; do
    # ONLY filter
    if [ -n "$ONLY" ] && [ "${f#*$ONLY}" = "$f" ]; then continue; fi

    # Output dir name: results/foo_bar/seed_3.json → analysis/foo_bar__seed_3
    env_name="$(basename "$(dirname "$f")")"
    seed_name="$(basename "$f" .json)"
    out_dir="analysis/${env_name}__${seed_name}"

    # Skip if already analysed
    if [ -f "$out_dir/summary.png" ] && [ $FORCE -eq 0 ]; then
        SKIPPED=$((SKIPPED + 1))
        printf "%-50s %12s %10s %10s  [SKIP]\n" "${env_name}/${seed_name}" "-" "-" "-"
        continue
    fi

    # Pull headline stats from the JSON for the progress table
    read -r ext pop spec <<< "$(node -e '
        const r = require("./'"$f"'");
        process.stdout.write([
            r.extinction_tick === null ? "none" : r.extinction_tick,
            r.final_population,
            r.final_species
        ].join(" "));
    ' 2>/dev/null || echo "? ? ?")"

    if [ "$ext" = "none" ]; then SURVIVED=$((SURVIVED + 1)); else EXTINCT=$((EXTINCT + 1)); fi

    # Run the analyzer, suppress its per-file progress noise
    if uv run scripts/analyze_results.py "$f" --out "$out_dir" > /dev/null 2>&1; then
        DONE=$((DONE + 1))
        printf "%-50s %12s %10s %10s  [done]\n" "${env_name}/${seed_name}" "$ext" "$pop" "$spec"
    else
        FAILED=$((FAILED + 1))
        printf "%-50s %12s %10s %10s  [FAIL]\n" "${env_name}/${seed_name}" "$ext" "$pop" "$spec"
    fi
done < "$TMP_LIST"

echo ""
echo "=== analyze_all finished ==="
echo "Done:     $DONE"
echo "Skipped:  $SKIPPED  (already had summary.png; pass --force to redo)"
echo "Failed:   $FAILED"
echo "Survived to max-ticks:  $SURVIVED / $((SURVIVED + EXTINCT))"
echo "Output:   analysis/"

exit $FAILED
