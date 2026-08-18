#!/usr/bin/env node
/* ───────────────────────────────────────────────────────────────────────────
 * generate_random_maps.js — Perlin "random emitter" maps for the
 * environment-complexity sweep (patch scale x food scarcity).
 *
 * WHY NODE AND NOT PYTHON: this reproduces the UI's "Generate Emitters" button
 * exactly by requiring the *same* modules it uses — src/Utils/Perlin.js and the
 * placement rule in EnvironmentController.randomizeEmitters:
 *
 *     xval  = c/cols * (resolution/cell_size * (cols/rows))
 *     yval  = r/rows * (resolution/cell_size * (rows/cols))
 *     emitter  iff  threshold < Perlin.get(xval,yval) < threshold + band
 *
 * so emitters are a thin CONTOUR BAND of a Perlin field (not a "> threshold"
 * blob): closed, organic ribbons. Connected components (8-neighbour flood fill)
 * are "islands", and each island emits ONE food type, cycling 1,2,3 in
 * discovery order — same as the UI.
 *
 * THE TWO SWEEP AXES ARE MADE ORTHOGONAL. In the UI, `resolution` sets both the
 * noise frequency AND the band width (thickness/resolution), so changing it
 * changes patch size and food quantity at once. Here:
 *
 *   - PATCH SCALE ("distance")  = --resolution. Periods across the map =
 *     resolution/cell_size, so feature size ~ size*cell_size/resolution cells.
 *     Low resolution -> few big widely-spaced ribbons; high -> many small ones.
 *   - SCARCITY  = --emitters, an exact target emitter COUNT. The band width is
 *     solved for (take the k-th smallest noise value above the threshold), so
 *     every map at a given scarcity level has the SAME number of emitters —
 *     i.e. the same total food production rate — regardless of patch scale.
 *
 * Founders (default: founder_species_1.json) are placed on the largest, most
 * widely separated islands, one species per island, with their mouth diets
 * retyped to that island's food type — so a run starts with a real multi-patch,
 * multi-diet seeding rather than the single-cluster seeding of the distance maps.
 *
 * Usage:
 *   node scripts/generate_random_maps.js --probe
 *   node scripts/generate_random_maps.js
 *   node scripts/generate_random_maps.js --resolutions 25,50,100 --emitters 224,672,1344
 *   node scripts/generate_random_maps.js --replicates 2 --arms both
 *   node scripts/generate_random_maps.js --founder-diet keep --founder-islands 1
 * ─────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs   = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const Rng    = require(path.join(REPO, 'src/Utils/Rng'));
const Perlin = require(path.join(REPO, 'src/Utils/Perlin'));

// ── defaults ───────────────────────────────────────────────────────────────
const DEF = {
    size:            500,
    cellSize:        4,           // matches grid.cell_size of the 500x500 fleet
    // UI's thickness arg: band width = thickness/resolution. 'auto' = (res/50)^2,
    // which holds the ribbon width roughly constant IN CELLS across resolutions
    // (band-in-cells ~ thickness*cell_size/res^2), so the scale axis changes how
    // food is laid out without also changing how wide each ribbon is. Fixed
    // thickness=1 is the literal UI default and is correct at res=50 only —
    // beyond ~res 70 it shatters the ribbons into single-cell dust.
    thickness:       'auto',
    searchFrom:      0.0,         // lowest contour level the scarcity search may use
    resolutions:     [25, 50, 100],
    emitters:        [224, 672, 1344],   // 1/3x, 1x, 2x the distance-map fleet's 672
    replicates:      1,
    seed:            1,
    arms:            'both',      // normal | predation | both
    founders:        6,
    founderIslands:  3,
    founderFile:     'founder_species_1.json',
    founderDiet:     'island',    // island | keep
    controlsFrom:    'maps/map_500_d05.json',
    out:             'maps/random_sweep',
    minIslandCells:  15,          // don't seed founders onto a 3-cell islet
    clear:           true,
};

// ── tiny arg parser (--key value / --key=value / --flag / --no-flag) ────────
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (!a.startsWith('--')) continue;
        a = a.slice(2);
        if (a.startsWith('no-')) { out[camel(a.slice(3))] = false; continue; }
        let [k, v] = a.split('=');
        if (v === undefined) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) { v = next; i++; }
            else v = true;
        }
        out[camel(k)] = v;
    }
    return out;
}
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const nums  = v => String(v).split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));

// ── the noise field (identical maths to randomizeEmitters) ─────────────────
function noiseField(size, cellSize, resolution, seed) {
    Rng.setSeed(seed);
    Rng.install();            // Perlin.rand_vect() -> Math.random() -> seeded
    Perlin.seed();            // clear gradients + memo so each field is fresh
    const cols = size, rows = size;
    const field = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const xval = c / cols * (resolution / cellSize * (cols / rows));
            const yval = r / rows * (resolution / cellSize * (rows / cols));
            field[r * cols + c] = Perlin.get(xval, yval);
        }
    }
    return field;
}

/** thickness for a resolution. 'auto' keeps ribbon width ~constant in cells. */
function thicknessFor(mode, res) {
    if (mode === 'auto' || mode === true) return Math.pow(res / 50, 2);
    const v = parseFloat(mode);
    return isNaN(v) ? 1 : v;
}

function countInBand(field, threshold, width) {
    let n = 0;
    for (let i = 0; i < field.length; i++) {
        const v = field[i];
        if (v > threshold && v < threshold + width) n++;
    }
    return n;
}

/** Solve the CONTOUR LEVEL for a target emitter count, at the UI's band width.
 *
 *  Scarcity is set by moving the level set up, not by thinning the band: a band
 *  narrow enough to hit a low count directly would shatter the ribbons into
 *  single-cell dust (median island size 1), which is a different kind of
 *  environment altogether. Holding width = thickness/resolution (exactly what
 *  the UI does with thickness=1) keeps the ribbons contiguous at every scarcity
 *  level; raising the threshold just leaves fewer, smaller, more isolated loops
 *  around the peaks of the field.
 *
 *  count(T) is unimodal in T (it tracks the noise PDF, peaking near 0), so the
 *  search is restricted to T >= searchFrom, where it is monotone decreasing. */
function solveThreshold(field, width, target, searchFrom = 0.0) {
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) if (field[i] > hi) hi = field[i];
    let lo = searchFrom;
    if (countInBand(field, lo, width) < target) {
        return { threshold: lo, count: countInBand(field, lo, width), saturated: true };
    }
    for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (countInBand(field, mid, width) >= target) lo = mid; else hi = mid;
    }
    return { threshold: lo, count: countInBand(field, lo, width), saturated: false };
}

/** Cells inside the band, in row-major insertion order (as the UI's Set is). */
function bandCells(field, size, threshold, width) {
    const out = [];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const v = field[r * size + c];
            if (v > threshold && v < threshold + width) out.push([c, r]);
        }
    }
    return out;
}

/** 8-neighbour flood fill -> islands, food type cycling 1,2,3 by discovery
 *  order (mirrors randomizeEmitters' third pass). */
function findIslands(cells, size) {
    const idx = new Int32Array(size * size).fill(-1);
    cells.forEach(([c, r], i) => { idx[r * size + c] = i; });
    const island = new Int32Array(cells.length).fill(-1);
    const islands = [];
    for (let i = 0; i < cells.length; i++) {
        if (island[i] !== -1) continue;
        const id = islands.length;
        const members = [];
        const stack = [i];
        island[i] = id;
        while (stack.length) {
            const j = stack.pop();
            members.push(j);
            const [c, r] = cells[j];
            for (let dc = -1; dc <= 1; dc++) {
                for (let dr = -1; dr <= 1; dr++) {
                    if (!dc && !dr) continue;
                    const nc = c + dc, nr = r + dr;
                    if (nc < 0 || nr < 0 || nc >= size || nr >= size) continue;
                    const k = idx[nr * size + nc];
                    if (k !== -1 && island[k] === -1) { island[k] = id; stack.push(k); }
                }
            }
        }
        let sc = 0, sr = 0;
        for (const j of members) { sc += cells[j][0]; sr += cells[j][1]; }
        islands.push({
            id, members, foodType: (id % 3) + 1,
            centroid: [sc / members.length, sr / members.length],
            size: members.length,
        });
    }
    return { islands, islandOf: island };
}

/** Multi-source 8-neighbour BFS -> Chebyshev distance to the nearest emitter
 *  for every cell. Mean over non-emitter cells = "how far is food". */
function distanceToNearest(cells, size) {
    const dist = new Int32Array(size * size).fill(-1);
    let frontier = [];
    for (const [c, r] of cells) { dist[r * size + c] = 0; frontier.push(r * size + c); }
    let d = 0;
    while (frontier.length) {
        const next = [];
        d++;
        for (const p of frontier) {
            const c = p % size, r = (p - c) / size;
            for (let dc = -1; dc <= 1; dc++) {
                for (let dr = -1; dr <= 1; dr++) {
                    if (!dc && !dr) continue;
                    const nc = c + dc, nr = r + dr;
                    if (nc < 0 || nr < 0 || nc >= size || nr >= size) continue;
                    const q = nr * size + nc;
                    if (dist[q] === -1) { dist[q] = d; next.push(q); }
                }
            }
        }
        frontier = next;
    }
    return dist;
}

/** Free space carved up by the ribbons. The emitter band is 8-connected, so the
 *  background is measured 4-connected (standard digital topology) — free space
 *  touching only at a diagonal counts as separated, which is the conservative
 *  reading for whether an organism can actually get through. Contour bands are
 *  closed loops, so this is the map's spatial fragmentation: how many pockets a
 *  population can be isolated in. */
function openRegions(cells, size, minCells = 100) {
    const blocked = new Uint8Array(size * size);
    for (const [c, r] of cells) blocked[r * size + c] = 1;
    const seen = new Uint8Array(size * size);
    const regions = [];
    for (let start = 0; start < seen.length; start++) {
        if (blocked[start] || seen[start]) continue;
        let n = 0;
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
            const p = stack.pop();
            n++;
            const c = p % size, r = (p - c) / size;
            if (c > 0        && !blocked[p - 1]    && !seen[p - 1])    { seen[p - 1] = 1;    stack.push(p - 1); }
            if (c < size - 1 && !blocked[p + 1]    && !seen[p + 1])    { seen[p + 1] = 1;    stack.push(p + 1); }
            if (r > 0        && !blocked[p - size] && !seen[p - size]) { seen[p - size] = 1; stack.push(p - size); }
            if (r < size - 1 && !blocked[p + size] && !seen[p + size]) { seen[p + size] = 1; stack.push(p + size); }
        }
        regions.push(n);
    }
    regions.sort((a, b) => b - a);
    const free = size * size - cells.length;
    return {
        open_regions:           regions.filter(n => n >= minCells).length,
        open_regions_all:       regions.length,
        largest_open_fraction:  +(regions.length ? regions[0] / free : 0).toFixed(3),
    };
}

function stats(cells, islands, dist, size) {
    let sum = 0, n = 0, max = 0;
    for (let i = 0; i < dist.length; i++) {
        if (dist[i] > 0) { sum += dist[i]; n++; if (dist[i] > max) max = dist[i]; }
    }
    const sizes = islands.map(i => i.size).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const big = islands.filter(i => i.size >= DEF.minIslandCells);
    // nearest-neighbour centroid distance between sizeable islands = patch spacing
    let nnSum = 0, nnN = 0;
    for (const a of big) {
        let best = Infinity;
        for (const b of big) {
            if (a.id === b.id) continue;
            const d = Math.hypot(a.centroid[0] - b.centroid[0], a.centroid[1] - b.centroid[1]);
            if (d < best) best = d;
        }
        if (isFinite(best)) { nnSum += best; nnN++; }
    }
    const perType = { 1: 0, 2: 0, 3: 0 };
    for (const isl of islands) perType[isl.foodType] += isl.size;
    return {
        emitters_total:        cells.length,
        emitters_per_type:     perType,
        emitter_fraction:      +(cells.length / (size * size)).toFixed(5),
        islands:               islands.length,
        islands_ge_min:        big.length,
        island_size_median:    median,
        island_size_max:       sizes.length ? sizes[sizes.length - 1] : 0,
        mean_dist_to_food:     +(n ? sum / n : 0).toFixed(2),
        max_dist_to_food:      max,
        mean_island_spacing:   +(nnN ? nnSum / nnN : 0).toFixed(2),
        ...openRegions(cells, size),
    };
}

// ── founder placement ──────────────────────────────────────────────────────
/** Pick `k` sizeable islands to seed.
 *
 *  Food type cycles 1,2,3 by island discovery order, so the largest islands can
 *  easily all carry the same type. When `distinctTypes` is set we take the
 *  largest island of each food type first (guaranteeing all three diets are
 *  actually seeded — the thing single-cluster seeding in the distance maps could
 *  never do), then fill any remaining slots farthest-point from those. */
function pickIslands(islands, k, minCells, distinctTypes = false) {
    const pool = islands.filter(i => i.size >= minCells).sort((a, b) => b.size - a.size);
    if (!pool.length) return [];
    const chosen = [];
    if (distinctTypes) {
        for (const t of [1, 2, 3]) {
            if (chosen.length >= k) break;
            const best = pool.find(i => i.foodType === t);
            if (best) chosen.push(best);
        }
    }
    if (!chosen.length) chosen.push(pool[0]);
    while (chosen.length < k && chosen.length < pool.length) {
        let best = null, bestD = -1;
        for (const cand of pool) {
            if (chosen.includes(cand)) continue;
            let d = Infinity;
            for (const ch of chosen) {
                const dd = Math.hypot(cand.centroid[0] - ch.centroid[0],
                                      cand.centroid[1] - ch.centroid[1]);
                if (dd < d) d = dd;
            }
            if (d > bestD) { bestD = d; best = cand; }
        }
        if (!best) break;
        chosen.push(best);
    }
    return chosen;
}

/** A clear spot near `island`: spiral out from one of its cells until a
 *  (2*rad+1)^2 box is free of emitters and in bounds. */
function findSpot(island, cells, occupied, size, rad, rand) {
    const seedCell = cells[island.members[Math.floor(rand() * island.members.length)]];
    for (let ring = rad + 2; ring < 60; ring++) {
        // sample the ring in a deterministic but varied order
        const cand = [];
        for (let a = 0; a < 24; a++) {
            const th = (a / 24) * 2 * Math.PI;
            cand.push([Math.round(seedCell[0] + ring * Math.cos(th)),
                       Math.round(seedCell[1] + ring * Math.sin(th))]);
        }
        for (let i = cand.length - 1; i > 0; i--) {           // shuffle
            const j = Math.floor(rand() * (i + 1));
            [cand[i], cand[j]] = [cand[j], cand[i]];
        }
        for (const [c, r] of cand) {
            if (c - rad < 1 || r - rad < 1 || c + rad >= size - 1 || r + rad >= size - 1) continue;
            let clear = true;
            for (let dc = -rad; dc <= rad && clear; dc++)
                for (let dr = -rad; dr <= rad && clear; dr++)
                    if (occupied.has((r + dr) * size + (c + dc))) clear = false;
            if (clear) {
                for (let dc = -rad; dc <= rad; dc++)
                    for (let dr = -rad; dr <= rad; dr++)
                        occupied.add((r + dr) * size + (c + dc));
                return [c, r];
            }
        }
    }
    return null;
}

function placeFounders(template, islands, cells, size, opts, rand) {
    const chosen = pickIslands(islands, opts.founderIslands, opts.minIslandCells,
                               opts.founderDiet === 'island');
    if (!chosen.length) return { organisms: [], seeded: [] };

    const rad = template.anatomy.cells.reduce(
        (m, cl) => Math.max(m, Math.abs(cl.loc_col), Math.abs(cl.loc_row)), 0) + 1;
    const occupied = new Set();
    for (const [c, r] of cells) {                    // keep clear of the ribbons
        for (let dc = -1; dc <= 1; dc++)
            for (let dr = -1; dr <= 1; dr++) {
                const nc = c + dc, nr = r + dr;
                if (nc >= 0 && nr >= 0 && nc < size && nr < size) occupied.add(nr * size + nc);
            }
    }

    const organisms = [], seeded = [];
    const perIsland = Math.max(1, Math.round(opts.founders / chosen.length));
    for (let k = 0; k < chosen.length; k++) {
        const isl = chosen[k];
        const type = opts.founderDiet === 'island' ? isl.foodType : null;
        // One species per island so the fossil record tracks the lineages apart
        // (organisms sharing a species_name share ONE Species object on load).
        const speciesName = opts.founderDiet === 'island'
            ? `${template.species_name}_t${isl.foodType}` : template.species_name;
        let placed = 0;
        for (let i = 0; i < perIsland && organisms.length < opts.founders; i++) {
            const spot = findSpot(isl, cells, occupied, size, rad, rand);
            if (!spot) break;
            const org = JSON.parse(JSON.stringify(template));
            org.c = spot[0]; org.r = spot[1];
            org.species_name = speciesName;
            if (type !== null) {
                for (const cl of org.anatomy.cells)
                    if (cl.state && cl.state.name === 'mouth') cl.diet = type;
            }
            organisms.push(org);
            placed++;
        }
        seeded.push({ island: isl.id, food_type: isl.foodType, species: speciesName,
                      island_cells: isl.size, centroid: isl.centroid.map(v => Math.round(v)),
                      organisms: placed });
    }
    return { organisms, seeded };
}

/** fossil_record.species entries for the placed founders — same shape the
 *  prepared distance maps carry. `population` MUST match how many organisms
 *  share the species_name (see the call site). */
function speciesRecords(organisms) {
    const out = {};
    for (const org of organisms) {
        const name = org.species_name;
        if (!out[name]) {
            const diets = new Set();
            for (const cl of org.anatomy.cells)
                if (cl.state && cl.state.name === 'mouth' && typeof cl.diet === 'number')
                    diets.add(cl.diet);
            out[name] = {
                population: 0, cumulative_pop: 0, start_tick: 0, end_tick: -1,
                extinct: false, mouth_diets: Array.from(diets).sort(),
            };
        }
        out[name].population++;
        out[name].cumulative_pop++;
    }
    return out;
}

// ── fossil-record skeleton (mirrors generate_maps.py empty_fossil_record) ───
function emptyFossilRecord() {
    const series = () => ({
        tick_record: [0], pop_counts: [0], species_counts: [0], av_mut_rates: [0],
        av_cells: [0], av_cell_counts: [{}], species_diet_counts: [{}],
        population_diet_counts: [{}], av_connections: [0], av_hidden_nodes: [0],
        species_populations: [{}],
    });
    return {
        extant_species: {}, extinct_species: {},
        min_discard: 10, min_serialize_keep: null, record_size_limit: 500,
        ...series(),
        full_tick_record: [0], full_pop_counts: [0], full_species_counts: [0],
        full_av_mut_rates: [0], full_av_cells: [0], full_av_cell_counts: [{}],
        full_species_diet_counts: [{}], full_population_diet_counts: [{}],
        full_av_connections: [0], full_av_hidden_nodes: [0], full_species_populations: [{}],
        records: series(), window_records: series(),
        species: {}, species_diets: {},
    };
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
    const a = parseArgs(process.argv.slice(2));
    const opts = {
        size:           a.size        ? parseInt(a.size)        : DEF.size,
        cellSize:       a.cellSize    ? parseInt(a.cellSize)    : DEF.cellSize,
        thickness:      a.thickness !== undefined ? a.thickness : DEF.thickness,
        searchFrom:     a.searchFrom !== undefined ? parseFloat(a.searchFrom) : DEF.searchFrom,
        resolutions:    a.resolutions ? nums(a.resolutions)     : DEF.resolutions,
        emitters:       a.emitters    ? nums(a.emitters)        : DEF.emitters,
        replicates:     a.replicates  ? parseInt(a.replicates)  : DEF.replicates,
        seed:           a.seed        ? parseInt(a.seed)        : DEF.seed,
        arms:           a.arms        || DEF.arms,
        founders:       a.founders    ? parseInt(a.founders)    : DEF.founders,
        founderIslands: a.founderIslands ? parseInt(a.founderIslands) : DEF.founderIslands,
        founderFile:    a.founderFile || DEF.founderFile,
        founderDiet:    a.founderDiet || DEF.founderDiet,
        controlsFrom:   a.controlsFrom|| DEF.controlsFrom,
        out:            a.out         || DEF.out,
        minIslandCells: a.minIslandCells ? parseInt(a.minIslandCells) : DEF.minIslandCells,
        clear:          a.clear === false ? false : DEF.clear,
        probe:          !!a.probe,
        noFounders:     a.founders === '0' || a.founders === 0,
    };

    const outDir = path.join(REPO, opts.out);

    if (opts.probe) {
        console.log(`probe — size=${opts.size} cell_size=${opts.cellSize} thickness=${opts.thickness} seed=${opts.seed}`);
        console.log(`${'res'.padStart(5)} ${'periods'.padStart(8)} ${'target'.padStart(7)} ${'got'.padStart(6)} ` +
                    `${'thresh'.padStart(8)} ${'islands'.padStart(8)} ${'>=15'.padStart(5)} ` +
                    `${'med'.padStart(5)} ${'max'.padStart(6)} ${'meanDist'.padStart(9)} ${'spacing'.padStart(8)}`);
        console.log('-'.repeat(96));
        for (const res of opts.resolutions) {
            const field = noiseField(opts.size, opts.cellSize, res, opts.seed);
            const thick = thicknessFor(opts.thickness, res);
            const width = thick / res;
            for (const target of opts.emitters) {
                const sol = solveThreshold(field, width, target, opts.searchFrom);
                const cells = bandCells(field, opts.size, sol.threshold, width);
                const { islands } = findIslands(cells, opts.size);
                const dist = distanceToNearest(cells, opts.size);
                const s = stats(cells, islands, dist, opts.size);
                console.log(`${String(res).padStart(5)} ${(res/opts.cellSize).toFixed(1).padStart(8)} ` +
                            `${String(target).padStart(7)} ${String(sol.count).padStart(6)} ` +
                            `${sol.threshold.toFixed(3).padStart(7)}${sol.saturated ? '*' : ' '} ` +
                            `${String(s.islands).padStart(8)} ${String(s.islands_ge_min).padStart(5)} ` +
                            `${String(s.island_size_median).padStart(5)} ${String(s.island_size_max).padStart(6)} ` +
                            `${s.mean_dist_to_food.toFixed(1).padStart(9)} ${s.mean_island_spacing.toFixed(1).padStart(8)}`);
            }
        }
        return;
    }

    // ── real generation ────────────────────────────────────────────────────
    const base = JSON.parse(fs.readFileSync(path.join(REPO, opts.controlsFrom), 'utf8'));
    const founderTemplate = opts.noFounders
        ? null : JSON.parse(fs.readFileSync(path.join(REPO, opts.founderFile), 'utf8'));

    fs.mkdirSync(outDir, { recursive: true });
    if (opts.clear) {
        const stale = fs.readdirSync(outDir).filter(f => f.endsWith('.json'));
        stale.forEach(f => fs.unlinkSync(path.join(outDir, f)));
        if (stale.length) console.log(`cleared ${stale.length} stale map(s) from ${opts.out}`);
    }

    const arms = opts.arms === 'both' ? [false, true]
               : opts.arms === 'predation' ? [true] : [false];

    console.log(`base controls: ${opts.controlsFrom}   founder: ${opts.noFounders ? '(none)' : opts.founderFile}` +
                `   diet: ${opts.founderDiet}`);
    console.log(`${'res'.padStart(5)} ${'emit'.padStart(6)} ${'rep'.padStart(4)} ${'islands'.padStart(8)} ` +
                `${'meanDist'.padStart(9)} ${'orgs'.padStart(5)} ${'pred'.padStart(5)}  file`);
    console.log('-'.repeat(96));

    let written = 0;
    for (const res of opts.resolutions) {
        for (let rep = 1; rep <= opts.replicates; rep++) {
            // one noise field per (resolution, replicate); scarcity levels are
            // nested bands of the SAME field, so a scarcity step is strictly
            // "less food in the same landscape".
            const fieldSeed = opts.seed * 1000 + rep;
            const field = noiseField(opts.size, opts.cellSize, res, fieldSeed);
            const thick = thicknessFor(opts.thickness, res);
            const width = thick / res;          // UI: thickness/resolution
            for (const target of opts.emitters) {
                const sol = solveThreshold(field, width, target, opts.searchFrom);
                if (sol.saturated) {
                    console.log(`  WARN: res=${res} rep=${rep} cannot reach ${target} emitters ` +
                                `(max ${sol.count} at threshold ${sol.threshold}) — using ${sol.count}`);
                }
                const cells = bandCells(field, opts.size, sol.threshold, width);
                const { islands, islandOf } = findIslands(cells, opts.size);
                const dist = distanceToNearest(cells, opts.size);
                const s = stats(cells, islands, dist, opts.size);

                Rng.setSeed(fieldSeed ^ 0x5f3759df);      // placement RNG
                const rand = () => Rng.random();
                const placed = opts.noFounders
                    ? { organisms: [], seeded: [] }
                    : placeFounders(founderTemplate, islands, cells, opts.size, opts, rand);

                for (const predation of arms) {
                    const env = JSON.parse(JSON.stringify(base));
                    env.grid = {
                        cell_size: opts.cellSize,
                        cols: opts.size, rows: opts.size,
                        food: [], walls: [],
                        emitters: cells.map(([c, r], i) => ({
                            c, r, t: islands[islandOf[i]].foodType,
                        })),
                    };
                    env.num_cols = opts.size;
                    env.num_rows = opts.size;
                    env.total_ticks = 0;
                    env.reset_count = 0;
                    env.organisms = JSON.parse(JSON.stringify(placed.organisms));
                    env.fossil_record = emptyFossilRecord();
                    // One species record per founder lineage, with the RIGHT
                    // population. Without it the loader's fallback path builds a
                    // Species with population=1 however many organisms share the
                    // name, so the 2nd founder's death drives the count negative:
                    // the lineage is fossilised as extinct while it is still
                    // alive ("Tried to fossilize non existing species").
                    env.fossil_record.species = speciesRecords(placed.organisms);
                    env.controls = { ...base.controls, dontKillSameSpecies: true };
                    env.controls.deadTurnToFood = !!predation;
                    env._meta = {
                        generator:        'scripts/generate_random_maps.js',
                        sweep:            'random_env',
                        mirrors:          'EnvironmentController.randomizeEmitters (UI: Generate Emitters)',
                        size:             opts.size,
                        cell_size:        opts.cellSize,
                        resolution:       res,
                        periods_across:   +(res / opts.cellSize).toFixed(2),
                        feature_size_cells: +(opts.size * opts.cellSize / res).toFixed(1),
                        noise_threshold:  +sol.threshold.toFixed(5),
                        band_width:       +width.toFixed(6),
                        thickness:        +thick.toFixed(4),
                        thickness_mode:   opts.thickness,
                        noise_seed:       fieldSeed,
                        replicate:        rep,
                        scarcity_target:  target,
                        predation_enabled: !!predation,
                        dont_kill_same_species: true,
                        meat_nutrition:   base.controls.foodTypes[0].nutrition,
                        founder_file:     opts.noFounders ? null : opts.founderFile,
                        founder_diet_mode: opts.founderDiet,
                        founder_seeding:  placed.seeded,
                        ...s,
                    };

                    const name = `rand_${opts.size}_r${String(res).padStart(3, '0')}` +
                                 `_e${String(target).padStart(4, '0')}` +
                                 (opts.replicates > 1 ? `_n${rep}` : '') +
                                 (predation ? '_predation' : '');
                    const file = path.join(outDir, `${name}.json`);
                    fs.writeFileSync(file, JSON.stringify(env));
                    console.log(`${String(res).padStart(5)} ${String(target).padStart(6)} ${String(rep).padStart(4)} ` +
                                `${String(s.islands).padStart(8)} ${s.mean_dist_to_food.toFixed(1).padStart(9)} ` +
                                `${String(env.organisms.length).padStart(5)} ${String(!!predation).padStart(5)}  ` +
                                `${path.relative(REPO, file)}`);
                    written++;
                }
            }
        }
    }
    console.log(`\nwrote ${written} map(s) to ${opts.out}`);
    if (!opts.noFounders && written) {
        console.log('founder seeding of the last map:');
        for (const s of JSON.parse(fs.readFileSync(
                path.join(outDir, fs.readdirSync(outDir).filter(f => f.endsWith('.json'))[0]),
                'utf8'))._meta.founder_seeding) {
            console.log(`  island ${s.island} (type ${s.food_type}, ${s.island_cells} cells) ` +
                        `at ${s.centroid} -> ${s.organisms} x ${s.species}`);
        }
    }
}

main();
