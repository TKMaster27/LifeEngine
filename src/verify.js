'use strict';

// ─── Browser shims (copied from headless.js) ──────────────────────────────────
const mockCtx = new Proxy({}, { get: (_, p) => typeof p === 'string' ? () => {} : undefined, set: () => true });
const mockEl  = { getContext: () => mockCtx, addEventListener: () => {}, removeEventListener: () => {}, onwheel: null, width: 800, height: 600 };
global.document  = { getElementById: () => mockEl, querySelector: () => mockEl, createElement: () => mockEl };
global.window    = global;
try { global.navigator = { userAgent: '' }; } catch (_) {}
global.confirm   = () => false;
const jqChain = new Proxy({}, { get(_, p) { const prim = { height: 600, width: 800, length: 1 }; if (p in prim) return () => prim[p]; if (p === 'is') return () => false; return function() { return jqChain; }; } });
global.$ = new Proxy(function() { return jqChain; }, { get(_, p) { if (p === 'fn') return {}; return jqChain[p] || function() { return jqChain; }; } });

// ─── Imports ──────────────────────────────────────────────────────────────────
const CellStates  = require('./Organism/Cell/CellStates');
const NNBrain     = require('./Organism/Perception/NNBrain');
const Organism    = require('./Organism/Organism');
const GridMap     = require('./Grid/GridMap');

// Minimal environment stub so Organism constructor doesn't crash.
const mockEnv = {
    grid_map:  { cellAt: () => null, cols: 20, rows: 20 },
    changeCell: () => {},
    total_ticks: 0,
    organisms: [],
};

// ─── Test harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(label, condition, detail = '') {
    if (condition) {
        console.log(`  ✓  ${label}`);
        passed++;
    } else {
        console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

function assertClose(label, a, b, tol = 1e-5) {
    const ok = Math.abs(a - b) < tol;
    assert(label, ok, `expected ${b}, got ${a}`);
}

// ─── Criterion 3: eye added via mutation rebuilds substrate without crash ──────
console.log('\n── Criterion 3: substrate rebuild on cell addition ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);

    // start: 1 mouth only — no eyes, no movers
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    assert('no eyes → n_inputs = 0',          org.brain.n_inputs  === 0);
    assert('no movers → n_outputs = 0',        org.brain.n_outputs === 0);

    // add mover
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    assert('mover added, still no eye → n_inputs = 0',  org.brain.n_inputs  === 0);
    assert('1 mover → n_outputs = 1',                   org.brain.n_outputs === 1);

    // add first eye → substrate should activate
    const INPUTS_PER_EYE = 16; // N_CELL_FEATURES(13) + dist + dx + dy
    org.anatomy.addDefaultCell(CellStates.eye, -1, 0);
    assert('1 eye + 1 mover → n_inputs = 16', org.brain.n_inputs  === INPUTS_PER_EYE);
    assert('1 eye + 1 mover → n_outputs = 1', org.brain.n_outputs === 1);
    assert('weights.length = 16',             org.brain.weights.length === INPUTS_PER_EYE);

    // add second eye — simulates an eye mutation
    org.anatomy.addDefaultCell(CellStates.eye, 0, -1);
    assert('2nd eye added → n_inputs = 32',   org.brain.n_inputs  === INPUTS_PER_EYE * 2);
    assert('n_outputs unchanged = 1',         org.brain.n_outputs === 1);
    assert('weights.length = 32',             org.brain.weights.length === INPUTS_PER_EYE * 2);
    assert('no NaN in weights', !Array.from(org.brain.weights).some(isNaN));

    // add second mover
    org.anatomy.addDefaultCell(CellStates.mover, 0, 1);
    assert('2nd mover → n_outputs = 2',       org.brain.n_outputs === 2);
    assert('weights.length = 64',             org.brain.weights.length === INPUTS_PER_EYE * 2 * 2);

    // remove the first eye — simulates death of eye cell
    org.anatomy.removeCell(-1, 0);
    assert('eye removed → n_inputs = 16',     org.brain.n_inputs  === INPUTS_PER_EYE);
    assert('weights preserved for remaining', org.brain.weights.length === INPUTS_PER_EYE * 2);
})();

// ─── Criterion 4: save/load round-trip reproduces identical decisions ─────────
console.log('\n── Criterion 4: save/load brain round-trip ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);

    const brain = org.brain;

    // Feed a known observation: food type 1 at distance 5, dx=2, dy=3
    const fakeFoodCell = { state: CellStates.food, foodType: 1 };
    brain.observe(fakeFoodCell, 5, 0, 0, 2, 3);
    const { thrusts: original } = brain.decide();

    // Serialize
    const serialized = brain.serialize();
    assert('serialize produces type=nn',       serialized.type === 'nn');
    assert('serialize has weights array',      Array.isArray(serialized.weights));
    assert('serialize has n_inputs',           serialized.n_inputs === brain.n_inputs);
    assert('serialize has n_outputs',          serialized.n_outputs === brain.n_outputs);

    // Load into a fresh brain on a new organism with identical anatomy
    const org2 = new Organism(10, 10, mockEnv, null);
    org2.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org2.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org2.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org2.brain.loadRaw(serialized);

    assert('loaded n_inputs matches',          org2.brain.n_inputs  === brain.n_inputs);
    assert('loaded n_outputs matches',         org2.brain.n_outputs === brain.n_outputs);
    assert('loaded weights.length matches',    org2.brain.weights.length === brain.weights.length);

    // Feed identical observation and compare outputs
    org2.brain.observe(fakeFoodCell, 5, 0, 0, 2, 3);
    const { thrusts: loaded } = org2.brain.decide();

    assert('same number of outputs',           loaded.length === original.length);
    for (let j = 0; j < original.length; j++) {
        assertClose(`thrust[${j}] identical after round-trip`, loaded[j], original[j]);
    }

    // Also verify copy() path
    const org3 = new Organism(10, 10, mockEnv, null);
    org3.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org3.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org3.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org3.brain.copy(brain);
    org3.brain.observe(fakeFoodCell, 5, 0, 0, 2, 3);
    const { thrusts: copied } = org3.brain.decide();
    for (let j = 0; j < original.length; j++) {
        assertClose(`thrust[${j}] identical after copy()`, copied[j], original[j]);
    }
})();

// ─── Diet-aware prior sanity check ───────────────────────────────────────────
console.log('\n── Diet-aware prior: food-in-diet weights positive ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);
    const mouth = org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mouth.diet = 2; // eats food type 2 (pink)
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    // rebuild substrate so it picks up the diet
    org.brain.buildSubstrate();

    const INPUTS_PER_EYE = 16;
    const FEAT_FOOD_2    = 3; // food type 2 is feature index 3
    const FEAT_FOOD_0    = 1;
    const FEAT_KILLER    = 10;
    const n_out          = org.brain.n_outputs;
    const w              = org.brain.weights;

    let food2_positive = true, food0_negative = true, killer_negative = true;
    for (let j = 0; j < n_out; j++) {
        if (w[FEAT_FOOD_2  * n_out + j] <= 0) food2_positive  = false;
        if (w[FEAT_FOOD_0  * n_out + j] >= 0) food0_negative  = false;
        if (w[FEAT_KILLER  * n_out + j] >= 0) killer_negative = false;
    }
    assert('in-diet food (type 2) weight > 0',    food2_positive);
    assert('out-of-diet food (type 0) weight < 0', food0_negative);
    assert('killer weight < 0',                    killer_negative);
})();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
