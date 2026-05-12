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

const opts      = parseArgs(process.argv.slice(2));
const MAX_TICKS = parseInt(opts['max-ticks']);
const OUTPUT    = opts['output']    || 'results.json';
const CONFIG    = opts['config']    || null;
const LOAD      = opts['load']      || null;
const LOG_EVERY = parseInt(opts['log-every'] || '10000');

if (isNaN(MAX_TICKS) || MAX_TICKS <= 0) {
    console.error(
        'Usage: node src/headless.js --max-ticks <N>\n' +
        '  [--output <results.json>]   output file path\n' +
        '  [--config <params.json>]    override hyperparameters\n' +
        '  [--load   <save.json>]      start from a saved environment\n' +
        '  [--log-every <N>]           print progress every N ticks (default 10000)'
    );
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

const env = new WorldEnvironment(engine, 5);

if (LOAD) {
    const raw = JSON.parse(fs.readFileSync(LOAD, 'utf8'));
    env.loadRaw(raw);
    console.log(`[headless] Environment loaded from ${LOAD} (tick ${env.total_ticks})`);
} else {
    env.OriginOfLife();
}

// ─── Simulation loop ──────────────────────────────────────────────────────────

console.log(`[headless] Starting: max_ticks=${MAX_TICKS}  output=${OUTPUT}`);
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

const results = {
    total_ticks:      env.total_ticks,
    elapsed_seconds:  parseFloat(wall_elapsed),
    ticks_per_second: parseFloat(wall_elapsed) > 0 ? Math.round(env.total_ticks / parseFloat(wall_elapsed)) : null,
    extinction_tick:  extinction_tick,
    reached_max_ticks: reached_max,
    final_population: env.organisms.length,
    final_species:    FossilRecord.numExtantSpecies(),
    fossil_record:    FossilRecord.serialize(),
};

fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));
console.log(`[headless] Results written to ${OUTPUT}`);
