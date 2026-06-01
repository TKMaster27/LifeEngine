#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot migration: move existing world-snapshot files out of results/
# into a parallel worlds/ tree, matching the new sweep-script convention:
#
#   results/<env>/seed_<N>_world.json  →  worlds/<env>/seed_<N>_world.json
#
# Tracked-results files (results/<env>/seed_<N>.json without the _world
# suffix) are left alone.
#
# Usage:
#   bash scripts/migrate_worlds.sh           # do it
#   bash scripts/migrate_worlds.sh --dry-run # show what would happen
#
# Idempotent — re-running after migration is a no-op.
# ─────────────────────────────────────────────────────────────────────────────

set -u

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-n" ]; then
    DRY_RUN=1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || { echo "ERROR: Cannot cd to $PROJECT_DIR"; exit 1; }

if [ ! -d results ]; then
    echo "Nothing to migrate — results/ does not exist."; exit 0
fi

mkdir -p worlds

MOVED=0
SKIPPED=0
CONFLICT=0

while IFS= read -r src; do
    env_name="$(basename "$(dirname "$src")")"
    fname="$(basename "$src")"
    dst_dir="worlds/$env_name"
    dst="$dst_dir/$fname"

    if [ -e "$dst" ]; then
        # Already at destination — leave the duplicate in results/ alone to be
        # safe; user can rm the source manually after diffing if they want.
        echo "[skip   ] $src   (destination exists: $dst)"
        SKIPPED=$((SKIPPED + 1))
        CONFLICT=$((CONFLICT + 1))
        continue
    fi

    if [ $DRY_RUN -eq 1 ]; then
        echo "[plan   ] $src  →  $dst"
    else
        mkdir -p "$dst_dir"
        if mv "$src" "$dst"; then
            echo "[moved  ] $src  →  $dst"
            MOVED=$((MOVED + 1))
        else
            echo "[ERROR  ] mv failed for $src"
        fi
    fi
done < <(find results -type f -name '*_world.json' | sort)

echo ""
if [ $DRY_RUN -eq 1 ]; then
    echo "Dry run complete. Re-run without --dry-run to actually move files."
else
    echo "Migration complete — moved $MOVED file(s), skipped $SKIPPED."
    if [ $CONFLICT -gt 0 ]; then
        echo "  ⚠ $CONFLICT file(s) already existed at the destination and were left in"
        echo "    place inside results/. Diff them yourself if you want to clean up:"
        echo "      diff <results-path> <worlds-path>"
    fi
fi
