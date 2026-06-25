# The Life Engine — UCT Honours research fork

> This fork (branch `tarique-ALife`) extends Max Robinson's original
> [Life Engine](https://thelifeengine.net/) with the machinery needed to run a
> Darwin's-finches-style adaptive-radiation study for an Honours ALife project
> at UCT. The user-facing browser simulator still works; the major additions
> are a HyperNEAT-CTRNN neural brain, terrain/emitter food sources, a headless
> CLI, seeded RNG, and a CHPC sweep+analysis workflow.

The life engine is a cellular automaton designed to simulate the long term
processes of biological evolution. It allows organisms to eat, reproduce,
mutate, and adapt. Unlike genetic algorithms it does not manually select the
most "fit" organism for some given task — true natural selection runs its
course. Organisms that survive, reproduce, and out-compete their neighbours
naturally propagate through the environment.

This is the second version of the
[original evolution simulator](https://github.com/MaxRobinsonTheGreat/EvolutionSimulator).

## What this fork adds

| Area | Change |
|---|---|
| **Brain** | The discrete FSM brain has been replaced by a HyperNEAT-encoded CTRNN — a CPPN evolves the weights, connection-existence (LEO), and per-neuron time constants (`tau`) for a fixed input/hidden/output substrate built from the organism's anatomy. Movement uses scalar thrust + torque per mover, integrated with an accumulator. See [BRAIN_REDESIGN.md](BRAIN_REDESIGN.md). |
| **Food types** | Food has a `foodType` (1–3 used; 0 reserved for predation work). Mouths inherit a diet; specialists absorb at 1× their food type, generalists absorb at 1/√n. |
| **Emitter cells** | Map-placed food sources that periodically spawn food of a configured type — used to build deterministic resource layouts for experiments. |
| **Terrain** | Perlin-noise island generator (`randomizeEmitters`, 4-pass) for procedural map building. |
| **Headless mode** | `src/headless.js` runs the simulation as a pure Node script with no canvas / DOM, writing a results JSON suitable for analysis. |
| **Seeded RNG** | `src/Utils/Rng.js` wraps a seedable PRNG and replaces `Math.random()` throughout. Runs with the same `--seed` reproduce bit-for-bit. |
| **Charts + CSV** | New `DietSpecializationChart` and `PopulationDietSpecializationChart` in the StatsPanel; every chart has a CSV download button. |
| **Cluster-spacing maps** | 500×500 experiment maps in `maps/` across N inter-cluster distance levels (default 10: `map_500_d01…d10`, plus `_predation` siblings). See [MAP_DESIGN.md](MAP_DESIGN.md). |
| **CHPC sweep** | `scripts/sweep.pbs` and `scripts/submit_all_maps.sh` run multi-seed sweeps on the UCT cluster. See [CHPC_GUIDE.md](CHPC_GUIDE.md) and [RUNNING_EXPERIMENTS.md](RUNNING_EXPERIMENTS.md). |
| **Analysis** | `scripts/analyze_results.py` produces per-run plots (population, species, diet specialisation, per-species lineages). Driven via `uv`. |

## Documentation map

| File | What it covers |
|---|---|
| [BRAIN_REDESIGN.md](BRAIN_REDESIGN.md) | Architecture of the HyperNEAT-CTRNN brain and the phased migration from the old FSM |
| [RESEARCH_READINESS_PLAN.md](RESEARCH_READINESS_PLAN.md) | What had to land for publication-grade 10M-tick runs (seeded RNG, lineage pruning, batch sweep, cross-run analysis) |
| [MAP_DESIGN.md](MAP_DESIGN.md) | The 500×500 cluster-spacing maps — geometry, emitter design, regeneration |
| [RUNNING_EXPERIMENTS.md](RUNNING_EXPERIMENTS.md) | End-to-end workflow: generate → push → submit → pull → analyse |
| [CHPC_GUIDE.md](CHPC_GUIDE.md) | One-time CHPC setup (NVM, Node 16, PBS) plus headless-flag reference |
| [PERFORMANCE_OPTIMIZATIONS.md](PERFORMANCE_OPTIMIZATIONS.md) | Tier 1–3 DoD speedup roadmap, profiling references |
| [Changelog.md](Changelog.md) | Upstream release notes (pre-fork) |

# Running the browser simulator

- [Install node and npm](https://nodejs.org/en/download/)
- Download or clone this repository
- In the project root, run `npm install`
- Run `npm run build` (or `npm run build-watch` during development)
  - If you get `Can't resolve jquery`, run `npm install --save jquery`
- Open `dist/index.html` in your browser. The simulation should start.

To load custom creations (in `/dist/assets`) you need a simple web server that
serves the dist directory:

- [Install python](https://www.python.org/downloads/)
- `python -m http.server --directory dist` from the repo root
- Open `http://localhost:8000/` in your browser

### Npm build commands

- Production (minified): `npm run build`
- Watch mode (auto-build on save): `npm run build-watch`
- Dev mode (better error messages): `npm run build-dev`

# Running headless

The headless runner is the entry point for the experiments — no browser, no
canvas, just a Node script that writes a results JSON.

```bash
node src/headless.js \
    --max-ticks 1000000 \
    --load      maps/map_500_d05.json \
    --seed      1 \
    --data-rate 1000 \
    --keep-min  50 \
    --output    results/map_500_d05/seed_1.json \
    --save-world results/map_500_d05/seed_1_world.json \
    --log-every 50000
```

Full flag reference is in [CHPC_GUIDE.md §7](CHPC_GUIDE.md#7-headless-mode-flags-reference).
For CHPC sweeps, use `scripts/sweep.pbs` (see [RUNNING_EXPERIMENTS.md](RUNNING_EXPERIMENTS.md)).

# How the Simulation Works

## The Environment

The environment is a grid of cells; each cell has a type at each tick.
Organisms are structures of multiple cells living on the grid.

## Cells

### Independent cells (not part of any organism)

- **Empty** — Dark blue, inert.
- **Food** — Grayish-blue; provides nourishment. Each food cell carries a
  `foodType` (1, 2, or 3 in the current experiments; 0 reserved for future
  predation).
- **Wall** — Gray; blocks movement and reproduction.
- **Emitter** — Map-placed source that periodically spawns food of a fixed type
  into a free cardinal neighbour. Used to build deterministic food layouts for
  experiments — see [MAP_DESIGN.md](MAP_DESIGN.md).

### Organism cells

- **Mouth** — Eats food in adjacent cells. Each mouth carries a `diet`
  (specialist for one food type, or generalist). Specialists absorb at 1×;
  generalists at 1/√n where n is the number of edible types — there is a real
  cost to being a generalist.
- **Producer** — Randomly generates food in adjacent empty cells.
- **Mover** — Carries a body-frame **direction** and contributes a scalar
  thrust (chosen by the brain) along that direction. The summed thrusts and
  their torques about the pivot drive continuous `(vx, vy, ω)` accumulators on
  the organism, snap-moving / snap-rotating when the accumulator crosses 1
  cell or 90°. Mover *placement* and *orientation* directly determine
  locomotion capability.
- **Killer** — Damages adjacent organisms (not itself).
- **Armor** — Negates killer effects.
- **Eye** — Has a direction; raycasts forward to the first non-empty cell
  within range, feeding cell-type / distance / dx-dy into the brain's input
  neurons.

## Organisms

Organisms are structures of cells that eat food, reproduce, and die.
When an organism dies, every grid cell it occupied is converted to food (the
food type matches the cell type origin where applicable). Lifespan is
`cell_count × Lifespan Multiplier`. Damage equal to the body cell count kills
an organism unless `One touch kill` is on, in which case any killer hit kills
instantly.

## Reproduction

Once an organism has accumulated as much food as it has cells, it attempts to
reproduce. The offspring is a (possibly mutated) clone, placed a programmatic
distance away in a random cardinal direction plus a small random offset.
Reproduction fails if the offspring would overlap any non-empty cell, and the
food cost is then wasted.

## Mutation

Offspring can mutate their anatomy by changing a cell, losing a cell, or
adding a cell. New cells are grown adjacent to an existing one. The brain
mutates independently of anatomy (CPPN topology and weight mutations); a CPPN
mutation triggers a substrate rebuild but leaves the substrate coordinates
(which come from anatomy) unchanged.

## Eyes and Brains

Any organism can evolve eyes. When an organism has at least one eye **and**
at least one mover, it is given a HyperNEAT-CTRNN brain:

- **Substrate**: input neurons at each eye's body-frame `(loc_col, loc_row)`,
  a small fixed 2×2 hidden grid, and one output neuron at each mover's
  position.
- **CPPN**: a NEAT-evolved network with `{sigmoid, gauss, sin, identity, abs}`
  activations. Given a `(src_x, src_y, dst_x, dst_y, distance, bias)` pair it
  outputs `weight`, `leo` (link-expression gate), and `tau` (per-target CTRNN
  time constant).
- **Dynamics**: leaky-integrator CTRNN per tick. The forward pass produces
  scalar thrusts at each output neuron; those drive the locomotion
  accumulator.

The key feature of this design is that morphology *is* part of the brain
genotype: relocating an eye or mover changes its substrate coordinate, the
CPPN is re-queried, and behaviour shifts accordingly — without any explicit
brain-genome surgery. That coupling is what makes morphological selection
informative for the research question. See [BRAIN_REDESIGN.md](BRAIN_REDESIGN.md)
for the full design rationale.

# Bug reports & feedback

Original-project bugs/features: use the upstream
[Discussions / Issues tabs](https://github.com/MaxRobinsonTheGreat/EvolutionSimulatorV2).
For research-fork issues, open one on
[TKMaster27/LifeEngine](https://github.com/TKMaster27/LifeEngine).
