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
const Genome       = require('./Organism/Perception/Genome');
const Innovation   = require('./Organism/Perception/Innovation');
const CPPN         = require('./Organism/Perception/CPPN');
const Organism     = require('./Organism/Organism');
const Hyperparams  = require('./Hyperparameters');

/** Force an organism's brain into Phase-2 direct mode for tests that target
 *  Phase-2 mechanics. */
function asDirect(org) {
    org.brain.encoding = "direct";
    org.brain.genome   = new (require('./Organism/Perception/Genome'))();
    org.brain.buildSubstrate();
    return org;
}

const mockEnv = {
    grid_map:  { cellAt: () => null, cols: 20, rows: 20 },
    changeCell: () => {},
    total_ticks: 0,
    organisms: [],
};

let passed = 0, failed = 0;
function assert(label, condition, detail = '') {
    if (condition) { console.log(`  ✓  ${label}`); passed++; }
    else           { console.error(`  ✗  ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}
function assertClose(label, a, b, tol = 1e-5) {
    assert(label, Math.abs(a - b) < tol, `expected ${b}, got ${a}`);
}

const INPUTS_PER_EYE = NNBrain.INPUTS_PER_EYE; // 16

function newOrg() { return new Organism(10, 10, mockEnv, null); }

// ─── Substrate rebuild on cell add/remove (DIRECT MODE — Phase 2 path) ─────
console.log('\n── Phase-2 direct mode: substrate rebuild on cell addition/removal ──');
(function() {
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    assert('no eyes → 0 input nodes',  org.brain.genome.inputs.length  === 0);
    assert('no movers → 0 output nodes', org.brain.genome.outputs.length === 0);

    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    assert('1 mover → 1 output node',  org.brain.genome.outputs.length === 1);
    assert('still 0 input nodes',      org.brain.genome.inputs.length  === 0);

    org.anatomy.addDefaultCell(CellStates.eye, -1, 0);
    assert('1 eye + 1 mover → 16 input nodes', org.brain.genome.inputs.length === INPUTS_PER_EYE);
    assert('genome seeded with 16 input→output connections',
           org.brain.genome.numEnabledConnections() === INPUTS_PER_EYE);
    assert('no hidden nodes initially (pure NEAT minimal)', org.brain.genome.hiddens.length === 0);

    org.anatomy.addDefaultCell(CellStates.eye, 0, -1);
    assert('2nd eye → 32 input nodes', org.brain.genome.inputs.length === INPUTS_PER_EYE * 2);
    assert('new eye seeded with 16 new I→O connections',
           org.brain.genome.numEnabledConnections() === INPUTS_PER_EYE * 2);

    org.anatomy.addDefaultCell(CellStates.mover, 0, 1);
    assert('2nd mover → 2 output nodes', org.brain.genome.outputs.length === 2);
    assert('connections doubled to cover both outputs (32 inputs × 2 outputs)',
           org.brain.genome.numEnabledConnections() === INPUTS_PER_EYE * 2 * 2);

    org.anatomy.removeCell(-1, 0);
    assert('eye removed → 16 input nodes', org.brain.genome.inputs.length === INPUTS_PER_EYE);
    assert('connections pruned to surviving inputs (16 × 2)',
           org.brain.genome.numEnabledConnections() === INPUTS_PER_EYE * 2);
})();

// ─── Save / load round-trip (direct mode) ───────────────────────────────────
console.log('\n── NEAT-v1 (direct mode) save/load round-trip reproduces identical decisions ──');
(function() {
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const brain = org.brain;

    // Force at least one structural mutation so the genome isn't trivial.
    const splitTarget = brain.genome.connections.find(c => c.enabled);
    brain.genome.addNodeOnConnection(splitTarget);
    assert('add_node introduced a hidden', brain.genome.hiddens.length === 1);

    const fakeFood = { state: CellStates.food, foodType: 1 };
    brain.observe(fakeFood, 5, 0, 0, 2, 3);
    const { thrusts: original } = brain.decide();

    const saved = brain.serialize();
    assert('serialize.type = nn',           saved.type   === 'nn');
    assert('serialize.format = neat-v1',    saved.format === 'neat-v1');
    assert('serialized genome present',     saved.genome && Array.isArray(saved.genome.connections));

    const org2 = newOrg();
    asDirect(org2);
    org2.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org2.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org2.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org2.brain.loadRaw(saved);

    assert('loaded same input count',       org2.brain.genome.inputs.length  === brain.genome.inputs.length);
    assert('loaded same output count',      org2.brain.genome.outputs.length === brain.genome.outputs.length);
    assert('loaded same hidden count',      org2.brain.genome.hiddens.length === brain.genome.hiddens.length);
    assert('loaded same connection count',  org2.brain.genome.connections.length === brain.genome.connections.length);

    org2.brain.observe(fakeFood, 5, 0, 0, 2, 3);
    const { thrusts: loaded } = org2.brain.decide();
    for (let j = 0; j < original.length; j++) {
        assertClose(`thrust[${j}] identical after round-trip`, loaded[j], original[j]);
    }

    // copy() path
    const org3 = newOrg();
    asDirect(org3);
    org3.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org3.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org3.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org3.brain.copy(brain);
    org3.brain.observe(fakeFood, 5, 0, 0, 2, 3);
    const { thrusts: copied } = org3.brain.decide();
    for (let j = 0; j < original.length; j++) {
        assertClose(`thrust[${j}] identical after copy()`, copied[j], original[j]);
    }
})();

// ─── Diet-aware prior is applied to fresh connections (direct mode) ────────
console.log('\n── Diet-aware prior on initial input→output connections (direct mode) ──');
(function() {
    const org = newOrg();
    asDirect(org);
    const mouth = org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mouth.diet = 2;
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org.brain.buildSubstrate();

    const FEAT_FOOD_2 = 3, FEAT_KILLER = 10;
    const conns = org.brain.genome.connections;

    const food2Conn  = conns.find(c => c.src === `i:0:${FEAT_FOOD_2}`);
    const killerConn = conns.find(c => c.src === `i:0:${FEAT_KILLER}`);

    assert('in-diet food (type 2) connection exists', !!food2Conn);
    assert('in-diet food (type 2) weight > 0',       food2Conn && food2Conn.weight > 0);
    assert('killer connection exists',                !!killerConn);
    assert('killer weight < 0',                       killerConn && killerConn.weight < 0);
})();

// ─── add_connection / add_node mutation enforcement (direct mode) ──────────
console.log('\n── NEAT structural mutations respect 1-hidden-layer rule (direct mode) ──');
(function() {
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = org.brain.genome;

    // Split an I→O connection — should produce one hidden.
    const ioConn = g.connections.find(c => c.enabled);
    const newHidden = g.addNodeOnConnection(ioConn);
    assert('add_node on I→O creates a hidden node', !!newHidden && g.hiddens.length === 1);
    assert('original I→O connection disabled after split', ioConn.enabled === false);
    assert('two new connections added (I→H, H→O)',
           g.connections.some(c => c.src === ioConn.src && c.dst === newHidden.id && c.enabled) &&
           g.connections.some(c => c.src === newHidden.id && c.dst === ioConn.dst && c.enabled));

    // Try to split an I→H connection — should be rejected.
    const ihConn = g.connections.find(c => c.enabled && c.src.startsWith('i:') && c.dst.startsWith('h:'));
    const rejected = g.addNodeOnConnection(ihConn);
    assert('add_node refuses to split I→H (would deepen the network)', rejected === null);
    assert('still only one hidden node', g.hiddens.length === 1);

    // Try to add an illegal hidden→hidden connection.
    const hid = g.addNodeOnConnection(g.connections.find(c =>
        c.enabled && c.src.startsWith('i:') && c.dst.startsWith('o:')
    ));
    assert('a second add_node on a different I→O creates a 2nd hidden', !!hid && g.hiddens.length === 2);

    const h1 = g.hiddens[0].id, h2 = g.hiddens[1].id;
    const illegal = g.addConnection(h1, h2, 0.5);
    assert('hidden → hidden connection rejected', illegal === null);

    // Self-loop rejection.
    const self = g.addConnection(h1, h1, 1.0);
    assert('self-loop on hidden rejected', self === null);

    // Output → anything rejection.
    const fromOutput = g.addConnection(g.outputs[0], h1, 1.0);
    assert('output as src rejected', fromOutput === null);
})();

// ─── Legacy two-layer save format backwards compatibility ───────────────────
console.log('\n── Backwards-compat: legacy Phase-1 (w1/w2) save loads as NEAT genome ──');
(function() {
    // Build a Phase-2 brain, capture its serialized form, then construct a
    // legacy-style serialised blob with the same weight values and confirm
    // the round-trip preserves outputs.
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const ni = INPUTS_PER_EYE, nh = 4, no = 1;
    const w1 = new Array(ni * nh); for (let k = 0; k < w1.length; k++) w1[k] = (k % 7 - 3) * 0.07;
    const w2 = new Array(nh * no); for (let k = 0; k < w2.length; k++) w2[k] = 0.3 + k * 0.05;
    const legacy = { type: 'nn', n_inputs: ni, n_hidden: nh, n_outputs: no, w1, w2 };

    org.brain.loadRaw(legacy);
    assert('legacy load gives same number of inputs',  org.brain.genome.inputs.length  === ni);
    assert('legacy load gives same number of outputs', org.brain.genome.outputs.length === no);
    assert('legacy load materialises 4 hidden nodes',  org.brain.genome.hiddens.length === nh);
    assert('legacy load produces I→H + H→O connections (no skip links)',
           org.brain.genome.numEnabledConnections() === ni * nh + nh * no);

    // Sample a weight and confirm round-trip.
    const probe = org.brain.genome.connections.find(c =>
        c.src === 'i:0:5' && c.dst.startsWith('h:legacy-')
    );
    const want = w1[5 * nh + parseInt(probe.dst.split('-')[1], 10)];
    assertClose('a sample input→hidden weight matches the source w1', probe.weight, want);
})();

// ─── Forward pass sanity (direct mode — we craft specific weights) ──────────
console.log('\n── Forward pass: signal propagates through hidden layer (direct mode) ──');
(function() {
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);

    // Wipe all weights so we can construct a controlled signal path.
    for (const c of org.brain.genome.connections) c.weight = 0;
    org.brain.genome._compiled = null;

    // Add an explicit I→H→O path with weight 1 (only that path).
    const FEAT_FOOD_1 = 2;
    const src = `i:0:${FEAT_FOOD_1}`;
    const dst = org.brain.genome.outputs[0];
    const ioConn = org.brain.genome.connections.find(c => c.src === src && c.dst === dst);
    const hid = org.brain.genome.addNodeOnConnection(ioConn);
    const hidId = hid.id;
    for (const c of org.brain.genome.connections) {
        if (c.enabled && ((c.src === src && c.dst === hidId) ||
                          (c.src === hidId && c.dst === dst))) {
            c.weight = 1.0;
        }
    }
    org.brain.genome._compiled = null;

    const fakeFood = { state: CellStates.food, foodType: 1 };
    org.brain.observe(fakeFood, 1, 0, 0, 0, 0);
    const { thrusts } = org.brain.decide();
    assert('food1 → hidden → output yields positive thrust', thrusts[0] > 0.1);

    // Reset CTRNN state so the empty observation isn't contaminated by the
    // membrane potential that just integrated the food-1 signal.
    org.brain.genome.resetState();
    org.brain.observe({ state: CellStates.empty }, 1, 0, 0, 0, 0);
    const { thrusts: z } = org.brain.decide();
    assertClose('no food1 signal → near-zero thrust', z[0], 0, 0.1);
})();

// ─── Phase 3: HyperNEAT default brain ─────────────────────────────────────
console.log('\n── Phase 3: default brain uses CPPN encoding ──');
(function() {
    const org = newOrg();
    assert('default encoding is "cppn"', org.brain.encoding === 'cppn');
    assert('CPPN is constructed',        org.brain.cppn instanceof CPPN);
    assert('CPPN starts with 0 hiddens', org.brain.cppn.numHiddenNodes() === 0);
    assert('CPPN starts fully I→O connected (8 × 2 = 16)',
           org.brain.cppn.numEnabledConnections() === 8 * 2);
})();

console.log('\n── Phase 3: substrate has fixed hidden grid ──');
(function() {
    const org = newOrg();
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = org.brain.genome;
    assert('substrate has 4 hidden-grid nodes', g.hiddens.length === 4);
    assert('hidden node ids are h:grid:0..3',
           g.hiddens.every((h, i) => h.id === `h:grid:${i}`));
    assert('hidden grid nodes carry coords', g.hiddens.every(h =>
        typeof h.x === 'number' && typeof h.y === 'number' && typeof h.z === 'number'
    ));
    // Some connections should be expressed (LEO > 0.5). With a fresh CPPN of
    // small-gaussian weights, leo passes through a sigmoid with input near
    // zero — about half the connections will fire on average.
    const n_enabled = g.numEnabledConnections();
    assert('CPPN-driven substrate has some enabled connections (>0)', n_enabled > 0);
})();

console.log('\n── Phase 3: CPPN forward pass is deterministic ──');
(function() {
    const c = new CPPN();
    const q1 = c.query(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7);
    const q2 = c.query(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7);
    assertClose('same query gives same weight', q1.weight, q2.weight);
    assertClose('same query gives same leo',    q1.leo,    q2.leo);
    const q3 = c.query(0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3);
    assert('different coords usually give different output',
           Math.abs(q1.weight - q3.weight) > 1e-6 || Math.abs(q1.leo - q3.leo) > 1e-6);
})();

console.log('\n── Phase 3: CPPN structural mutations work ──');
(function() {
    const c = new CPPN();
    const startConns = c.connections.length;
    assert('add_random_connection eventually adds an edge (or returns null cleanly)',
           c.addRandomConnection() === null || c.connections.length > startConns);
    const startHidden = c.hiddens.length;
    const newH = c.addRandomNode();
    assert('add_random_node creates a hidden', newH && c.hiddens.length === startHidden + 1);
    assert('new hidden has one of the 6 standard activations',
           CPPN.ACTIVATION_NAMES.includes(newH.activation));
    const before = newH.activation;
    c.mutateRandomActivation();
    // After mutation the activation may or may not actually flip if the RNG
    // hits the same one repeatedly; assert that *some* hidden has a valid
    // activation rather than strict change.
    assert('after mutateRandomActivation, hidden still has a valid activation',
           CPPN.ACTIVATION_NAMES.includes(c.hiddens[0].activation));
})();

console.log('\n── Phase 3: HyperNEAT save / load round-trip ──');
(function() {
    const org = newOrg();
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org.brain.cppn.addRandomNode();   // make the CPPN non-trivial
    org.brain.cppn.perturbWeights(0.5);
    org.brain.buildSubstrate();

    const fakeFood = { state: CellStates.food, foodType: 1 };
    org.brain.observe(fakeFood, 5, 0, 0, 2, 3);
    const { thrusts: original } = org.brain.decide();

    const saved = org.brain.serialize();
    assert('format = hyperneat-v1',           saved.format === 'hyperneat-v1');
    assert('saved.cppn present',              !!saved.cppn);
    assert('saved.cppn.type = cppn-v1',       saved.cppn.type === 'cppn-v1');

    const org2 = newOrg();
    org2.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org2.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org2.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org2.brain.loadRaw(saved);

    assert('loaded encoding = cppn',           org2.brain.encoding === 'cppn');
    assert('loaded CPPN hidden count matches', org2.brain.cppn.numHiddenNodes() === org.brain.cppn.numHiddenNodes());
    assert('loaded CPPN connection count matches', org2.brain.cppn.connections.length === org.brain.cppn.connections.length);

    org2.brain.observe(fakeFood, 5, 0, 0, 2, 3);
    const { thrusts: loaded } = org2.brain.decide();
    for (let j = 0; j < original.length; j++) {
        assertClose(`thrust[${j}] identical after hyperneat round-trip`, loaded[j], original[j]);
    }
})();

console.log('\n── Phase 3.1: fresh CPPN starts with LEO gate open ──');
(function() {
    const c = new CPPN();
    // Sample query at a few coords — leo should be > 0.5 across them for a
    // fresh CPPN, otherwise the seeding contract is broken.
    const samples = [
        [-1, -1, -1,  1,  1, 1, 0.5],
        [ 0,  0,  0,  0,  0, 0, 0.0],
        [ 0.5, -0.5, 0.3, -0.5, 0.5, 0, 0.7],
    ];
    let all_expressed = true;
    for (const s of samples) {
        const q = c.query(...s);
        if (!q.expressed) { all_expressed = false; break; }
    }
    assert('fresh CPPN expresses connections at typical query coords', all_expressed);
})();

console.log('\n── Phase 3.1: CPPN-encoded organism gets the diet-aware seeding prior ──');
(function() {
    const org = newOrg();
    const mouth = org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mouth.diet = 2;
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    org.brain.onDietChanged();  // re-blend prior with diet = 2

    // Pick a sample I→O connection for the food-type-2 feature and one for
    // the killer feature. Both should reflect the prior even though the
    // CPPN's weight output is near zero.
    const FEAT_FOOD_2 = 3, FEAT_KILLER = 10;
    const movOut = org.brain.genome.outputs[0];

    const food2Conn  = org.brain.genome.connections.find(c =>
        c.src === `i:0:${FEAT_FOOD_2}` && c.dst === movOut);
    const killerConn = org.brain.genome.connections.find(c =>
        c.src === `i:0:${FEAT_KILLER}` && c.dst === movOut);

    assert('food-type-2 (in-diet) substrate connection exists', !!food2Conn);
    assert('food-type-2 weight is positive (prior pulls it up)',
           food2Conn && food2Conn.weight > 0.3);
    assert('killer substrate connection exists', !!killerConn);
    assert('killer weight is negative (prior pushes it down)',
           killerConn && killerConn.weight < -0.3);

    // Empty-bias: every input→output connection for FEAT_EMPTY should also
    // carry a small positive offset.
    const emptyConn = org.brain.genome.connections.find(c =>
        c.src === `i:0:0` && c.dst === movOut);
    assert('empty-feature → output has a positive forward bias',
           emptyConn && emptyConn.weight > 0.1);
})();

console.log('\n── Phase 3.1: cppnSeedPriorStrength=0 disables seeding ──');
(function() {
    // Build two organisms with the same CPPN (cloned) but different prior
    // strengths. The substrate weight for a food-in-diet connection should
    // differ by approximately the prior magnitude (+1.0) between the two.
    const orgA = newOrg();
    const mA = orgA.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mA.diet = 1;
    orgA.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    orgA.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    orgA.brain.onDietChanged();

    const orgB = newOrg();
    orgA.brain.cppn.cloneInto(orgB.brain.cppn);
    const mB = orgB.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    mB.diet = 1;
    orgB.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    orgB.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const prev = Hyperparams.cppnSeedPriorStrength;
    Hyperparams.cppnSeedPriorStrength = 0;
    try {
        orgB.brain.buildSubstrate();
    } finally {
        Hyperparams.cppnSeedPriorStrength = prev;
    }

    const FEAT_FOOD_1 = 2;
    const ca = orgA.brain.genome.connections.find(
        x => x.src === `i:0:${FEAT_FOOD_1}` && x.dst === orgA.brain.genome.outputs[0]
    );
    const cb = orgB.brain.genome.connections.find(
        x => x.src === `i:0:${FEAT_FOOD_1}` && x.dst === orgB.brain.genome.outputs[0]
    );
    assert('both organisms have a food-1 → output connection', !!ca && !!cb);
    // With prior enabled (strength 1.0) the food-1 weight is bigger by ~1.0
    // than with prior disabled, since the CPPN contribution is the same.
    const diff = ca.weight - cb.weight;
    assertClose('prior contributes +1.0 to food-in-diet weight', diff, 1.0, 0.01);
})();

console.log('\n── Phase 3 regression: orphaned hidden node does not break CPPN forward pass ──');
(function() {
    // Reproduce the long-run crash: split a connection, then disable the
    // hidden's sole incoming edge so it is orphaned, then query the CPPN.
    // Before the fix this returned undefined from incoming.get(node) and
    // crashed in the inner forward-pass loop.
    const c = new CPPN();
    const hidden = c.addRandomNode();
    assert('add_node created a hidden', !!hidden);
    // Find the (input → hidden) edge add_node created and disable it.
    const inEdge = c.connections.find(e =>
        e.enabled && e.dst === hidden.id && e.src.startsWith('in:')
    );
    assert('hidden has an enabled incoming edge to disable', !!inEdge);
    inEdge.enabled = false;
    c._compiled = null;  // mimic what a mutation does

    let crashed = false, q = null;
    try {
        q = c.query(0.1, 0.2, 0.3, -0.4, -0.5, 0.6, 0.7);
    } catch (e) {
        crashed = true;
    }
    assert('query does not throw with an orphaned hidden', !crashed);
    assert('query still returns weight/leo/expressed fields',
           q && typeof q.weight === 'number' && typeof q.leo === 'number' &&
           typeof q.expressed === 'boolean');
})();

console.log('\n── Phase 3: CPPN mutation refreshes substrate weights ──');
(function() {
    const org = newOrg();
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    // Snapshot substrate weight pattern.
    const before = org.brain.genome.connections.map(c => c.weight).join(',');
    // Heavy mutation to maximise chance the substrate visibly changes.
    org.brain.cppn.perturbWeights(2.0);
    org.brain.buildSubstrate();
    const after = org.brain.genome.connections.map(c => c.weight).join(',');
    assert('substrate weights differ after large CPPN perturbation', before !== after);
})();

// ─── Phase 4: CTRNN dynamics ──────────────────────────────────────────────
console.log('\n── Phase 4: CTRNN state accumulates across forward() calls ──');
(function() {
    // Construct a direct-mode brain with a single hidden node and a single
    // input→hidden→output path. Set τ=4 so state changes are visible.
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = org.brain.genome;
    // Wipe all weights to zero so only the path we craft matters.
    for (const c of g.connections) c.weight = 0;
    g._compiled = null;
    // Split FOOD_1 → output to introduce a hidden.
    const FEAT_FOOD_1 = 2;
    const ioConn = g.connections.find(c =>
        c.src === `i:0:${FEAT_FOOD_1}` && c.dst === g.outputs[0]
    );
    const hid = g.addNodeOnConnection(ioConn);
    // Set weights = 1 on the I→H and H→O edges only, override tau.
    const ih = g.connections.find(c => c.src === ioConn.src && c.dst === hid.id);
    const ho = g.connections.find(c => c.src === hid.id     && c.dst === ioConn.dst);
    ih.weight = 1.0;
    ho.weight = 1.0;
    hid.tau   = 4.0;          // α = 1/4 = 0.25 — slow integrator
    g._compiled = null;

    const food = { state: CellStates.food, foodType: 1 };
    const samples = [];
    for (let t = 0; t < 8; t++) {
        org.brain.observe(food, 1, 0, 0, 0, 0);
        const { thrusts } = org.brain.decide();
        samples.push(thrusts[0]);
    }
    // Each tick the state climbs by α=0.25 of (sum − state) so successive
    // thrusts must be monotonically increasing while saturating.
    let monotonic = true;
    for (let i = 1; i < samples.length; i++) {
        if (samples[i] < samples[i - 1] - 1e-4) { monotonic = false; break; }
    }
    assert('thrust climbs monotonically across ticks under τ=4', monotonic);
    assert('first tick thrust is small (state still near zero)', samples[0] < 0.3);
    assert('later ticks approach saturation (state close to sum)', samples[samples.length - 1] > 0.6);
})();

console.log('\n── Phase 4: τ=1 reproduces feedforward (no state) ──');
(function() {
    // Same path as the previous test but with τ=1 — every tick should give
    // an identical thrust because α=1 means state = sum every tick.
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = org.brain.genome;
    for (const c of g.connections) c.weight = 0;
    g._compiled = null;
    const FEAT_FOOD_1 = 2;
    const ioConn = g.connections.find(c =>
        c.src === `i:0:${FEAT_FOOD_1}` && c.dst === g.outputs[0]
    );
    const hid = g.addNodeOnConnection(ioConn);
    const ih = g.connections.find(c => c.src === ioConn.src && c.dst === hid.id);
    const ho = g.connections.find(c => c.src === hid.id     && c.dst === ioConn.dst);
    ih.weight = 1.0; ho.weight = 1.0; hid.tau = 1.0;
    g._compiled = null;

    const food = { state: CellStates.food, foodType: 1 };
    org.brain.observe(food, 1, 0, 0, 0, 0);
    const a = org.brain.decide().thrusts[0];
    org.brain.observe(food, 1, 0, 0, 0, 0);
    const b = org.brain.decide().thrusts[0];
    assertClose('τ=1 → identical thrust on repeated identical inputs', b, a, 1e-5);
})();

console.log('\n── Phase 4: state is fresh on cloneInto (offspring) ──');
(function() {
    const orgA = newOrg();
    asDirect(orgA);
    orgA.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    orgA.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    orgA.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = orgA.brain.genome;
    for (const c of g.connections) c.weight = 0;
    g._compiled = null;
    const FEAT_FOOD_1 = 2;
    const ioConn = g.connections.find(c =>
        c.src === `i:0:${FEAT_FOOD_1}` && c.dst === g.outputs[0]
    );
    const hid = g.addNodeOnConnection(ioConn);
    const ih = g.connections.find(c => c.src === ioConn.src && c.dst === hid.id);
    const ho = g.connections.find(c => c.src === hid.id     && c.dst === ioConn.dst);
    ih.weight = 1.0; ho.weight = 1.0; hid.tau = 4.0;
    g._compiled = null;

    // Run parent forward a few times to build up state.
    const food = { state: CellStates.food, foodType: 1 };
    for (let t = 0; t < 6; t++) {
        orgA.brain.observe(food, 1, 0, 0, 0, 0);
        orgA.brain.decide();
    }
    assert('parent state has accumulated above zero',
           Math.abs(orgA.brain.genome._hidden_state[0]) > 0.1);

    const orgB = newOrg();
    asDirect(orgB);
    orgB.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    orgB.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    orgB.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    orgB.brain.copy(orgA.brain);
    assert('child state[0] is zero immediately after copy',
           orgB.brain.genome._hidden_state[0] === 0);

    // First decide on child should give a small thrust (state still 0),
    // while the parent's next thrust uses its accumulated state.
    orgA.brain.observe(food, 1, 0, 0, 0, 0);
    orgB.brain.observe(food, 1, 0, 0, 0, 0);
    const tParent = orgA.brain.decide().thrusts[0];
    const tChild  = orgB.brain.decide().thrusts[0];
    assert('parent thrust > child thrust on the same observation (state effect)',
           tParent > tChild + 0.05);
})();

console.log('\n── Phase 4: ctrnnEnabled=false bypasses the integrator ──');
(function() {
    const org = newOrg();
    asDirect(org);
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const g = org.brain.genome;
    for (const c of g.connections) c.weight = 0;
    g._compiled = null;
    const FEAT_FOOD_1 = 2;
    const ioConn = g.connections.find(c =>
        c.src === `i:0:${FEAT_FOOD_1}` && c.dst === g.outputs[0]
    );
    const hid = g.addNodeOnConnection(ioConn);
    const ih = g.connections.find(c => c.src === ioConn.src && c.dst === hid.id);
    const ho = g.connections.find(c => c.src === hid.id     && c.dst === ioConn.dst);
    ih.weight = 1.0; ho.weight = 1.0; hid.tau = 8.0;  // would normally cause a slow ramp

    const prev = Hyperparams.ctrnnEnabled;
    Hyperparams.ctrnnEnabled = false;
    try {
        const food = { state: CellStates.food, foodType: 1 };
        org.brain.observe(food, 1, 0, 0, 0, 0);
        const a = org.brain.decide().thrusts[0];
        org.brain.observe(food, 1, 0, 0, 0, 0);
        const b = org.brain.decide().thrusts[0];
        assertClose('with ctrnnEnabled=false, repeated inputs give identical thrust', b, a, 1e-5);
        assert('thrust is non-trivial (signal still propagates)', Math.abs(a) > 0.1);
    } finally {
        Hyperparams.ctrnnEnabled = prev;
    }
})();

console.log('\n── Phase 4: HyperNEAT substrate uses ctrnnDefaultTau ──');
(function() {
    const org = newOrg();
    org.anatomy.addDefaultCell(CellStates.mouth, 0, 0);
    org.anatomy.addDefaultCell(CellStates.mover, 1, 0);
    org.anatomy.addDefaultCell(CellStates.eye,  -1, 0);
    const taus = org.brain.genome.hiddens.map(h => h.tau);
    assert('all 4 hidden-grid nodes carry ctrnnDefaultTau=' + Hyperparams.ctrnnDefaultTau,
           taus.length === 4 && taus.every(t => t === Hyperparams.ctrnnDefaultTau));
})();

console.log(`\n${'─'.repeat(48)}`);
console.log(`${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
