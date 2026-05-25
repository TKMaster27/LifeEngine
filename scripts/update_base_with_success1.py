"""One-shot transform: seed Experiment1_Base with copies of the Success1.json creature.

Spawns 5 founders south of the food cluster (which lives at rows ~226-275, cols
~225-275). Row 290 is 15 below the cluster's south edge — close enough for the
eye (lookRange=30) to see food at spawn, far enough that locomotion is exercised.

Usage:
    uv run scripts/update_base_with_success1.py
"""

import copy
import json
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BASE_PATH = REPO / "Experiment1_Base.json"
SUCCESS_PATH = REPO / "Success1.json"

# Spawn 5 founders along the south edge of the food cluster.
# Each Success1 organism occupies cols c..c+2 and rows r..r+2, so 10-col spacing
# leaves a safe gap between bodies.
SPAWN_POINTS = [
    (230, 290),
    (240, 290),
    (250, 290),
    (260, 290),
    (270, 290),
]


def main():
    base = json.loads(BASE_PATH.read_text())
    success = json.loads(SUCCESS_PATH.read_text())

    n_founders = len(SPAWN_POINTS)

    # Cell-type counts for one founder (all copies share the same anatomy).
    cell_counts = {"mouth": 0, "producer": 0, "mover": 0, "killer": 0, "armor": 0, "eye": 0}
    for cell in success["anatomy"]["cells"]:
        name = cell["state"]["name"]
        if name in cell_counts:
            cell_counts[name] += 1
    n_cells = len(success["anatomy"]["cells"])

    # Diet bucket (all founders share the same diet).
    diets = {
        c.get("diet")
        for c in success["anatomy"]["cells"]
        if c["state"]["name"] == "mouth" and "diet" in c
    }
    diet_bucket = {f"type{t}_only": 0 for t in range(4)}
    diet_bucket["generalist"] = 0
    diet_bucket["none"] = 0
    if len(diets) == 0:
        diet_bucket["none"] = n_founders
    elif len(diets) == 1:
        diet_bucket[f"type{next(iter(diets))}_only"] = n_founders
    else:
        diet_bucket["generalist"] = n_founders

    species_name = success.get("species_name") or "baseline_founder"

    # Build the founder list — one copy of the Success1 organism per spawn point.
    organisms = []
    for (c, r) in SPAWN_POINTS:
        clone = copy.deepcopy(success)
        clone["c"] = c
        clone["r"] = r
        clone["species_name"] = species_name
        organisms.append(clone)
    base["organisms"] = organisms
    base["largest_cell_count"] = max(base.get("largest_cell_count", 0), n_cells)
    base["total_mutability"] = success.get("mutability", base.get("total_mutability", 0))

    # Rewrite the tick-0 fossil record entries to match the new founders.
    records = base["fossil_record"]["records"]
    records["tick_record"] = [0]
    records["pop_counts"] = [n_founders]
    records["species_counts"] = [1]
    records["av_mut_rates"] = [success.get("mutability", 5)]
    records["av_cells"] = [n_cells]
    records["av_cell_counts"] = [cell_counts]
    records["species_diet_counts"] = [diet_bucket]
    records["population_diet_counts"] = [diet_bucket]

    # Reseed the species table — one species, n_founders organisms.
    base["fossil_record"]["species"] = {
        species_name: {
            "population": n_founders,
            "cumulative_pop": n_founders,
            "start_tick": 0,
            "end_tick": -1,
            "extinct": False,
            "founder_brain": success["brain"],
        }
    }

    # Update the _meta description so it matches the new founders.
    meta = base.setdefault("_meta", {})
    cells_summary = ", ".join(
        f"{c['state']['name']}({c['loc_col']},{c['loc_row']}"
        + (f",diet={c['diet']}" if 'diet' in c else "")
        + (f",dir={c['direction']}" if 'direction' in c else "")
        + ")"
        for c in success["anatomy"]["cells"]
    )
    meta["founder_anatomy"] = f"Imported from Success1.json — {cells_summary}. Trained NN brain."
    meta["founder_layout"] = (
        f"{n_founders} founders spawned south of the food cluster (cluster spans rows ~226-275); "
        f"positions: {SPAWN_POINTS}. Eye looks up (direction=0) so each founder sees food in its column at spawn."
    )
    meta.setdefault("regenerated", "")
    meta["regenerated"] = (meta["regenerated"] + " | " if meta["regenerated"] else "") + \
        f"Seeded {n_founders} Success1 founders south of food cluster; species={species_name}."

    BASE_PATH.write_text(json.dumps(base, indent=2))
    print(f"[base] wrote {BASE_PATH}")
    print(f"  founders:    {n_founders}")
    print(f"  per founder: {n_cells} cells {cell_counts}")
    print(f"  species:     {species_name}")
    print(f"  spawn pts:   {SPAWN_POINTS}")


if __name__ == "__main__":
    main()
