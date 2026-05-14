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
const CellStates   = require('./Organism/Cell/CellStates');
const NNBrain      = require('./Organism/Perception/NNBrain');
const Organism     = require('./Organism/Organism');
const Hyperparams  = require('./Hyperparameters');

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

const INPUTS_PER_EYE = 16; // N_CELL_FEATURES(13) + dist + dx + dy
const N_HIDDEN       = Hyperparams.nnHiddenSize || 4;

// ─── Criterion 3: eye/mover mutations rebuild substrate correctly ─────────────
console.log('\n── Criterion 3: substrate rebuild on cell addition/removal ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);

    // start: 1 mouth only — no eyes, no movers
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    assert('no eyes → n_inputs = 0',                   org.brain.n_inputs  === 0);
    assert('no movers → n_outputs = 0',                org.brain.n_outputs === 0);
    assert('no eyes → n_hidden = 0',                   org.brain.n_hidden  === 0);

    // add mover — inputs still 0 so hidden layer stays dormant
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    assert('mover added, no eye → n_inputs = 0',       org.brain.n_inputs  === 0);
    assert('1 mover → n_outputs = 1',                  org.brain.n_outputs === 1);
    assert('no eye → n_hidden still 0',                org.brain.n_hidden  === 0);

    // add first eye → substrate activates
    org.anatomy.addDefaultCell(CellStates.eye, -1, 0);
    assert('1 eye + 1 mover → n_inputs = 16',          org.brain.n_inputs  === INPUTS_PER_EYE);
    assert('1 eye + 1 mover → n_outputs = 1',          org.brain.n_outputs === 1);
    assert(`1 eye → n_hidden = ${N_HIDDEN}`,            org.brain.n_hidden  === N_HIDDEN);
    assert(`w1.length = ${INPUTS_PER_EYE * N_HIDDEN}`, org.brain.w1.length === INPUTS_PER_EYE * N_HIDDEN);
    assert(`w2.length = ${N_HIDDEN * 1}`,              org.brain.w2.length === N_HIDDEN * 1);
    assert('no NaN in w1', !Array.from(org.brain.w1).some(isNaN));
    assert('no NaN in w2', !Array.from(org.brain.w2).some(isNaN));

    // add second eye
    org.anatomy.addDefaultCell(CellStates.eye, 0, -1);
    assert('2nd eye → n_inputs = 32',                  org.brain.n_inputs  === INPUTS_PER_EYE * 2);
    assert('n_outputs unchanged = 1',                  org.brain.n_outputs === 1);
    assert(`w1.length = ${INPUTS_PER_EYE * 2 * N_HIDDEN}`, org.brain.w1.length === INPUTS_PER_EYE * 2 * N_HIDDEN);
    assert('w2.length unchanged',                      org.brain.w2.length === N_HIDDEN * 1);

    // add second mover
    org.anatomy.addDefaultCell(CellStates.mover, 0, 1);
    assert('2nd mover → n_outputs = 2',                org.brain.n_outputs === 2);
    assert('w1.length unchanged after mover add',      org.brain.w1.length === INPUTS_PER_EYE * 2 * N_HIDDEN);
    assert(`w2.length = ${N_HIDDEN * 2}`,              org.brain.w2.length === N_HIDDEN * 2);

    // remove the first eye (pre-splice test)
    org.anatomy.removeCell(-1, 0);
    assert('eye removed → n_inputs = 16',              org.brain.n_inputs  === INPUTS_PER_EYE);
    assert('w1 shrinks after eye removal',             org.brain.w1.length === INPUTS_PER_EYE * N_HIDDEN);
    assert('no NaN after eye removal',                 !Array.from(org.brain.w1).some(isNaN));
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
    assert('serialize produces type=nn',         serialized.type === 'nn');
    assert('serialize has w1 array',             Array.isArray(serialized.w1));
    assert('serialize has w2 array',             Array.isArray(serialized.w2));
    assert('serialize has n_inputs',             serialized.n_inputs  === brain.n_inputs);
    assert('serialize has n_hidden',             serialized.n_hidden  === brain.n_hidden);
    assert('serialize has n_outputs',            serialized.n_outputs === brain.n_outputs);
    assert(`serialize w1.length = ${brain.w1.length}`, serialized.w1.length === brain.w1.length);
    assert(`serialize w2.length = ${brain.w2.length}`, serialized.w2.length === brain.w2.length);

    // Load into a fresh brain on a new organism with identical anatomy
    const org2 = new Organism(10, 10, mockEnv, null);
    org2.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org2.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org2.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org2.brain.loadRaw(serialized);

    assert('loaded n_inputs matches',            org2.brain.n_inputs  === brain.n_inputs);
    assert('loaded n_hidden matches',            org2.brain.n_hidden  === brain.n_hidden);
    assert('loaded n_outputs matches',           org2.brain.n_outputs === brain.n_outputs);
    assert('loaded w1.length matches',           org2.brain.w1.length === brain.w1.length);
    assert('loaded w2.length matches',           org2.brain.w2.length === brain.w2.length);

    // Feed identical observation and compare outputs
    org2.brain.observe(fakeFoodCell, 5, 0, 0, 2, 3);
    const { thrusts: loaded } = org2.brain.decide();

    assert('same number of outputs',             loaded.length === original.length);
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

// ─── Diet-aware prior: w1 weights reflect diet correctly ─────────────────────
console.log('\n── Diet-aware prior: food-in-diet w1 weights positive ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);
    const mouth = org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mouth.diet = 2; // eats food type 2
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org.brain.buildSubstrate(); // refresh so diet prior is applied

    const FEAT_FOOD_2 = 3; // food type 2 → feature index 3
    const FEAT_FOOD_0 = 1;
    const FEAT_KILLER = 10;
    const nh = org.brain.n_hidden;

    let food2_positive = true, food0_negative = true, killer_negative = true;
    for (let h = 0; h < nh; h++) {
        if (org.brain.w1[FEAT_FOOD_2 * nh + h] <= 0) food2_positive  = false;
        if (org.brain.w1[FEAT_FOOD_0 * nh + h] >= 0) food0_negative  = false;
        if (org.brain.w1[FEAT_KILLER * nh + h] >= 0) killer_negative = false;
    }
    assert('in-diet food (type 2) w1 weight > 0',    food2_positive);
    assert('out-of-diet food (type 0) w1 weight < 0', food0_negative);
    assert('killer w1 weight < 0',                    killer_negative);
})();

// ─── Hidden layer forward pass sanity check ───────────────────────────────────
console.log('\n── Hidden layer: forward pass is non-trivially two-layer ──');

(function() {
    const org = new Organism(10, 10, mockEnv, null);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const brain = org.brain;

    // Zero out w1, set w2 to all-positive → output should be near 0 (tanh(0))
    brain.w1.fill(0);
    brain.w2.fill(1);
    const fakeFoodCell = { state: CellStates.food, foodType: 1 };
    brain.observe(fakeFoodCell, 1, 0, 0, 0, 0);
    const { thrusts: t0 } = brain.decide();
    assertClose('zero w1 → zero hidden → ~0 output', t0[0], 0, 0.01);

    // Set w1 food1 row to +1 for all hidden neurons, w2 to +1 → output should be positive
    const FEAT_FOOD_1 = 2;
    const nh = brain.n_hidden;
    for (let h = 0; h < nh; h++) brain.w1[FEAT_FOOD_1 * nh + h] = 1.0;
    brain.observe(fakeFoodCell, 1, 0, 0, 0, 0);
    const { thrusts: t1 } = brain.decide();
    assert('food1 signal through w1→hidden→w2 gives positive thrust', t1[0] > 0.1);
})();

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
