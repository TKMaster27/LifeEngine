'use strict';

// ─── Mock browser globals ─────────────────────────────────────────────────────
// Stub out DOM / jQuery so canvas-based modules load without errors.
// All drawing calls become no-ops; rendering is skipped via WorldConfig.headless.

const mockCtx = new Proxy({}, {
    get: (_, prop) => typeof prop === 'string' ? () => {} : undefined,
    set: () => true,
});

const mockEl = {
    getContext:      () => mockCtx,
    addEventListener: () => {},
    removeEventListener: () => {},
    onwheel: null,
    width:  800,
    height: 600,
};

global.document = {
    getElementById: () => mockEl,
    querySelector:  () => mockEl,
    createElement:  () => mockEl,
};
global.window    = global;
try { global.navigator = { userAgent: '' }; } catch (_) {}
global.confirm   = () => false; // suppress browser dialogs

// Minimal jQuery stub — returns a chainable object for any selector
const jqChain = new Proxy({}, {
    get(_, prop) {
        const primitives = { height: 600, width: 800, length: 1 };
        if (prop in primitives) return () => primitives[prop];
        if (prop === 'is')   return () => false;
        if (prop === '0')    return { click: () => {} };
        return function() { return jqChain; };
    }
});
global.$ = new Proxy(function() { return jqChain; }, {
    get(_, prop) {
        if (prop === 'fn') return {};
        return jqChain[prop] || function() { return jqChain; };
    }
});

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                opts[key] = next;
                i++;
            } else {
                opts[key] = true;
            }
        }
    }
    return opts;
}

const opts       = parseArgs(process.argv.slice(2));
const MAX_TICKS  = parseInt(opts['max-ticks']);
const OUTPUT     = opts['output']    || 'results.json';
const CONFIG     = opts['config']    || null;
const LOAD       = opts['load']      || null;
const LOG_EVERY  = parseInt(opts['log-every'] || '10000');
const GRID_WIDTH = opts['width']     ? parseInt(opts['width'])     : null;
const GRID_HEIGHT= opts['height']    ? parseInt(opts['height'])    : null;
const CELL_SIZE  = opts['cell-size'] ? parseInt(opts['cell-size']) : 4;

if (isNaN(MAX_TICKS) || MAX_TICKS <= 0) {
    console.error(
        'Usage: node src/headless.js --max-ticks <N>\n' +
        '  [--output    <results.json>]   output file path\n' +
        '  [--config    <params.json>]    override hyperparameters\n' +
        '  [--load      <save.json>]      start from a saved environment\n' +
        '  [--width     <N>]              grid width in columns (default: renderer default)\n' +
        '  [--height    <N>]              grid height in rows   (default: renderer default)\n' +
        '  [--cell-size <N>]              pixel size of each cell (default 4)\n' +
        '  [--log-every <N>]              print progress every N ticks (default 10000)'
    );
    process.exit(1);
}

if (GRID_WIDTH  !== null && (isNaN(GRID_WIDTH)  || GRID_WIDTH  <= 0)) {
    console.error('ERROR: --width must be a positive integer.');
    process.exit(1);
}
if (GRID_HEIGHT !== null && (isNaN(GRID_HEIGHT) || GRID_HEIGHT <= 0)) {
    console.error('ERROR: --height must be a positive integer.');
    process.exit(1);
}
if (isNaN(CELL_SIZE) || CELL_SIZE <= 0) {
    console.error('ERROR: --cell-size must be a positive integer.');
    process.exit(1);
}

// ─── Load simulation modules ──────────────────────────────────────────────────

const WorldConfig      = require('./WorldConfig');
const Hyperparams      = require('./Hyperparameters');
const WorldEnvironment = require('./Environments/WorldEnvironment');
const FossilRecord     = require('./Stats/FossilRecord');
const fs               = require('fs');

WorldConfig.headless   = true;
WorldConfig.auto_pause = false;
WorldConfig.auto_reset = false;

if (CONFIG) {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    // Serialized env files store hyperparams under 'controls'; plain param files are used directly
    Hyperparams.loadJsonObj(raw.controls || raw);
    console.log(`[headless] Hyperparameters loaded from ${CONFIG}`);
}

// ─── Minimal engine shim ──────────────────────────────────────────────────────

const engine = {
    fps:       Infinity,
    last_fps:  Infinity,
    running:   true,
    stop()          { this.running = false; },
    start(fps)      { this.fps = fps || Infinity; this.last_fps = this.fps; this.running = true; },
    restart(fps)    { this.start(fps); },
};

// ─── Boot environment ─────────────────────────────────────────────────────────

const env = new WorldEnvironment(engine, CELL_SIZE);

if (LOAD) {
    if (GRID_WIDTH !== null || GRID_HEIGHT !== null) {
        console.warn('[headless] WARNING: --width/--height are ignored when --load is used (grid size comes from the save file).');
    }
    const raw = JSON.parse(fs.readFileSync(LOAD, 'utf8'));
    env.loadRaw(raw);
    // Apply embedded controls unless a separate --config was already given.
    // WorldEnvironment.loadRaw skips this behind a UI checkbox that is always
    // false in headless, so we do it explicitly here.
    if (!CONFIG && raw.controls) {
        Hyperparams.loadJsonObj(raw.controls);
        console.log(`[headless] Controls loaded from ${LOAD}`);
    }
    console.log(`[headless] Environment loaded from ${LOAD} (tick ${env.total_ticks})`);
} else {
    if (GRID_WIDTH !== null || GRID_HEIGHT !== null) {
        const cols = GRID_WIDTH  || env.grid_map.cols;
        const rows = GRID_HEIGHT || env.grid_map.rows;
        env.resizeGridColRow(CELL_SIZE, cols, rows);
        console.log(`[headless] Grid resized to ${cols}x${rows} cells (cell size: ${CELL_SIZE}px)`);
    }
    env.OriginOfLife();
}

// ─── Simulation loop ──────────────────────────────────────────────────────────

console.log(`[headless] Starting: max_ticks=${MAX_TICKS}  grid=${env.grid_map.cols}x${env.grid_map.rows}  output=${OUTPUT}`);
const wall_start     = Date.now();
let   extinction_tick = null;

while (env.total_ticks < MAX_TICKS && engine.running) {
    env.update();

    if (env.organisms.length === 0 && extinction_tick === null) {
        extinction_tick = env.total_ticks;
        console.log(`[headless] Extinction at tick ${extinction_tick} — stopping early.`);
        break;
    }

    if (LOG_EVERY > 0 && env.total_ticks % LOG_EVERY === 0) {
        const elapsed = ((Date.now() - wall_start) / 1000).toFixed(1);
        const rate    = (env.total_ticks / ((Date.now() - wall_start) / 1000)).toFixed(0);
        console.log(
            `[headless] tick=${env.total_ticks}/${MAX_TICKS}` +
            `  pop=${env.organisms.length}` +
            `  species=${FossilRecord.numExtantSpecies()}` +
            `  ${rate} ticks/s` +
            `  elapsed=${elapsed}s`
        );
    }
}

const wall_elapsed = ((Date.now() - wall_start) / 1000).toFixed(2);
const reached_max  = env.total_ticks >= MAX_TICKS;
console.log(
    `[headless] Done — ${env.total_ticks} ticks in ${wall_elapsed}s` +
    (reached_max ? ' (reached max-ticks)' : ' (extinction)')
);

// ─── Save results ─────────────────────────────────────────────────────────────

FossilRecord.updateData();

// Build a per-organism record of the survivors at end-of-run.
// This is the "evolved" brain — after living, eating, and reproducing — so it's
// the right thing to promote into the next iteration's starting weights.
function anatomySignature(org) {
    return org.anatomy.cells
        .map(c => `${c.loc_col},${c.loc_row}:${c.state.name}${typeof c.diet === 'number' ? '/d' + c.diet : ''}${typeof c.direction === 'number' ? '/r' + c.direction : ''}`)
        .sort()
        .join('|');
}

const livingRanked = env.organisms.map(org => ({
    species:        org.species ? org.species.name : null,
    species_cum_pop: org.species ? org.species.cumulative_pop : 0,
    lifetime:       org.lifetime,
    food_collected: org.food_collected,
    fitness:        org.lifetime > 0 ? org.food_collected / org.lifetime : 0,
    anatomy_sig:    anatomySignature(org),
    anatomy:        org.anatomy.serialize(),
    brain:          org.brain && org.brain.serialize ? org.brain.serialize() : null,
}))
.filter(o => o.brain)
.sort((a, b) =>
    (b.species_cum_pop - a.species_cum_pop) ||
    (b.fitness         - a.fitness)         ||
    (b.lifetime        - a.lifetime)
);

const results = {
    total_ticks:       env.total_ticks,
    elapsed_seconds:   parseFloat(wall_elapsed),
    ticks_per_second:  parseFloat(wall_elapsed) > 0 ? Math.round(env.total_ticks / parseFloat(wall_elapsed)) : null,
    extinction_tick:   extinction_tick,
    reached_max_ticks: reached_max,
    final_population:  env.organisms.length,
    final_species:     FossilRecord.numExtantSpecies(),
    grid_cols:         env.grid_map.cols,
    grid_rows:         env.grid_map.rows,
    cell_size:         env.grid_map.cell_size,
    fossil_record:     FossilRecord.serialize(),
    founder_brains_ranked:    FossilRecord.exportFounderBrainsRanked(),
    living_organisms_ranked:  livingRanked,
};

fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
console.log(`[headless] Results written to ${OUTPUT}`);
