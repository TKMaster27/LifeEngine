const Hyperparams = require("../../Hyperparameters");
const CellStates = require("../Cell/CellStates");
const Brain = require("./Brain");
const Genome = require("./Genome");
const CPPN    = require("./CPPN");

// ─── Substrate hidden grid (HyperNEAT) ────────────────────────────────────
// Four fixed hidden nodes arranged in a 2×2 quadrant pattern around the body
// centre. Their substrate coordinates are stable across all organisms and
// generations — the CPPN's job is to learn how those fixed positions ought
// to be wired to the (variable, anatomy-derived) input and output nodes.
const HIDDEN_GRID = [
    { id: "h:grid:0", x: -0.5, y: -0.5, z: 0 },
    { id: "h:grid:1", x:  0.5, y: -0.5, z: 0 },
    { id: "h:grid:2", x: -0.5, y:  0.5, z: 0 },
    { id: "h:grid:3", x:  0.5, y:  0.5, z: 0 },
];

// Normalisation scale for substrate coordinates. Body-local positions are
// expected to fit within ~5 cells of the body centre; dividing by 5 keeps
// the CPPN inputs in roughly [-1, 1] for realistic anatomies.
const COORD_SCALE = 5;
// Maximum 3D distance under that scale, used to normalise the distance input.
const COORD_DIST_NORM = Math.sqrt(12);  // sqrt((2)^2 + (2)^2 + (2)^2)

// ─── Eye-observation feature layout ───────────────────────────────────────
// Food is split into 4 type-specific slots so the brain can distinguish diets.
const FEAT_EMPTY    = 0;
const FEAT_FOOD_0   = 1;
const FEAT_FOOD_1   = 2;
const FEAT_FOOD_2   = 3;
const FEAT_FOOD_3   = 4;
const FEAT_WALL     = 5;
const FEAT_MOUTH    = 6;
const FEAT_PRODUCER = 7;
const FEAT_EMITTER  = 8;
const FEAT_MOVER    = 9;
const FEAT_KILLER   = 10;
const FEAT_ARMOR    = 11;
const FEAT_EYE      = 12;
const N_CELL_FEATURES = 13;

// Inputs per eye: N_CELL_FEATURES one-hot + normalised distance + dx + dy = 16
const INPUTS_PER_EYE = N_CELL_FEATURES + 3;

function cellFeatureIndex(cell) {
    if (!cell || !cell.state || cell.state === CellStates.empty) return FEAT_EMPTY;
    const name = cell.state.name;
    if (name === 'food') {
        const ft = (typeof cell.foodType === 'number' && cell.foodType >= 0 && cell.foodType <= 3)
            ? cell.foodType : 0;
        return FEAT_FOOD_0 + ft;
    }
    switch (name) {
        case 'wall':     return FEAT_WALL;
        case 'mouth':    return FEAT_MOUTH;
        case 'producer': return FEAT_PRODUCER;
        case 'emitter':  return FEAT_EMITTER;
        case 'mover':    return FEAT_MOVER;
        case 'killer':   return FEAT_KILLER;
        case 'armor':    return FEAT_ARMOR;
        case 'eye':      return FEAT_EYE;
        default:         return FEAT_EMPTY;
    }
}

function gaussRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Deterministic node-id schema. The order of inputs in the genome MUST match
// the order EyeCell.look() writes into obs_buffer, otherwise the wrong cell
// is fed into the wrong substrate input.
const inputId  = (eye_index, feat_index) => "i:" + eye_index + ":" + feat_index;
const outputId = (mover_index)           => "o:" + mover_index;

/** Diet-aware prior used to seed new connections so a freshly hatched
 *  organism doesn't have to discover "go toward food" from scratch.
 *  Includes small gaussian noise on non-special features to break symmetry
 *  across an organism's initial direct-mode substrate. */
function dietAwarePriorWeight(src, dst, dietSet) {
    // src is an input id "i:<eye_index>:<feat_index>"
    if (!src.startsWith("i:")) return gaussRandom() * 0.1;
    const feat = parseInt(src.split(":")[2], 10);
    if (feat >= FEAT_FOOD_0 && feat <= FEAT_FOOD_3) {
        if (dietSet.size === 0) return gaussRandom() * 0.1;
        const foodType = feat - FEAT_FOOD_0;
        return dietSet.has(foodType) ? 1.0 : -0.2;
    }
    if (feat === FEAT_KILLER) return -1.0;
    // return gaussRandom() * 0.1;
    if (feat === FEAT_EMPTY) return 0.35;
    return gaussRandom() * 0.1;
}

/** Deterministic version of the prior used to blend into CPPN-generated
 *  substrate weights. Returns the same domain-knowledge bias as the direct-
 *  mode prior but with NO random component — the CPPN's outputs supply all
 *  the variance, so adding more noise here would just blur the signal. Also
 *  returns 0 (no contribution) for non-special features instead of the small
 *  gaussian used in direct mode. */
function featurePriorWeight(src, dietSet) {
    if (!src.startsWith("i:")) return 0;
    const feat = parseInt(src.split(":")[2], 10);
    if (feat >= FEAT_FOOD_0 && feat <= FEAT_FOOD_3) {
        if (dietSet.size === 0) return 0;
        const foodType = feat - FEAT_FOOD_0;
        return dietSet.has(foodType) ? 1.0 : -0.2;
    }
    if (feat === FEAT_KILLER) return -1.0;
    if (feat === FEAT_EMPTY)  return 0.35;
    return 0;
}

class NNBrain extends Brain {
    constructor(owner) {
        super();
        this.owner = owner;
        // Encoding tag — "cppn" is the Phase-3 default; legacy saves switch
        // to "direct" when loaded (no CPPN, substrate weights are mutated
        // directly via the Phase-2 NEAT operators).
        this.encoding = "cppn";
        this.cppn     = new CPPN();
        this.genome   = new Genome();
        this.obs_buffer   = new Float32Array(0);
        this.last_thrusts = new Float32Array(0);
        this.eye_cell_count = 0;
        // Cached map of substrate-node id → {x, y, z} for CPPN queries.
        this._node_coords = new Map();
        this.buildSubstrate();
    }

    // ─── Anatomy-aware substrate maintenance ────────────────────────────

    /** Collect the set of food type IDs this organism's mouth cells eat. */
    _getDietSet() {
        const diet = new Set();
        for (const c of this.owner.anatomy.cells) {
            if (c.state === CellStates.mouth && typeof c.diet === 'number') {
                diet.add(c.diet);
            }
        }
        return diet;
    }

    /** Walk anatomy.cells producing the canonical input/output id lists plus
     *  per-node substrate coordinates. The order must match EyeCell.look()'s
     *  eye_index numbering and the mover-index numbering used by
     *  Organism.update(). */
    _anatomyIO(excludeCell) {
        const input_ids   = [];
        const output_ids  = [];
        const node_coords = new Map();
        let n_eyes = 0, n_movers = 0;
        for (const c of this.owner.anatomy.cells) {
            if (c === excludeCell) continue;
            if (c.state === CellStates.eye) {
                const x = c.loc_col / COORD_SCALE;
                const y = c.loc_row / COORD_SCALE;
                for (let f = 0; f < INPUTS_PER_EYE; f++) {
                    const id = inputId(n_eyes, f);
                    input_ids.push(id);
                    // Feature index normalised to [-1, 1].
                    const z = (f / (INPUTS_PER_EYE - 1)) * 2 - 1;
                    node_coords.set(id, { x, y, z });
                }
                n_eyes++;
            } else if (c.state === CellStates.mover) {
                const id = outputId(n_movers);
                output_ids.push(id);
                node_coords.set(id, {
                    x: c.loc_col / COORD_SCALE,
                    y: c.loc_row / COORD_SCALE,
                    z: 0,
                });
                n_movers++;
            }
        }
        return { input_ids, output_ids, node_coords, n_eyes, n_movers };
    }

    /** Build the substrate. Branches on encoding:
     *   - "cppn":   discard the old genome's structure, install the fixed
     *               hidden grid, then ask the CPPN for every substrate weight
     *               and prune connections whose LEO gate is closed.
     *   - "direct": Phase-2 behaviour — incrementally setIO + seed prior
     *               weights on newly-introduced I/O nodes. */
    buildSubstrate(excludeCell = null) {
        const { input_ids, output_ids, node_coords, n_eyes } = this._anatomyIO(excludeCell);
        this.eye_cell_count = n_eyes;

        if (this.encoding === "cppn") {
            this._buildSubstrateFromCPPN(input_ids, output_ids, node_coords);
        } else {
            this._buildSubstrateDirect(input_ids, output_ids);
        }

        const n_in = input_ids.length;
        if (this.obs_buffer.length !== n_in) {
            this.obs_buffer = new Float32Array(n_in);
        }
        if (this.last_thrusts.length !== output_ids.length) {
            this.last_thrusts = new Float32Array(output_ids.length);
        }
    }

    /** HyperNEAT substrate build: query the CPPN once per potential
     *  (src, dst) substrate pair to populate weights, prune by LEO gate.
     *
     *  The CPPN is purely geometric — it sees substrate coords but has no
     *  visibility of the organism's diet. To give fresh organisms a fair
     *  starting point ("see food, move forward; see killer, retreat") we
     *  blend a deterministic, diet-aware prior on top of the CPPN's output.
     *  Connections whose prior contribution is significant are force-
     *  expressed even when LEO closes, so seeding can't be wiped out by an
     *  unlucky CPPN initial weight. */
    _buildSubstrateFromCPPN(input_ids, output_ids, node_coords) {
        // Start with a fresh substrate — the CPPN's outputs fully determine it.
        const g = new Genome();
        g.inputs  = input_ids.slice();
        g.outputs = output_ids.slice();

        // ── Pass 1: ask the CPPN for τ at each hidden-grid position ──────
        // We query the CPPN at (h.pos, h.pos, distance=0) — i.e. a self-pair
        // — and map its `out:tau` (sigmoid ∈ (0, 1)) to the configured
        // [ctrnnMinTau, ctrnnMaxTau] range. This makes τ a function of
        // substrate position, so the CPPN can evolve "fast-reactor" vs
        // "long-memory" regions of the hidden layer separately.
        const minTau = Hyperparams.ctrnnMinTau != null ? Hyperparams.ctrnnMinTau : 1.0;
        const maxTau = Hyperparams.ctrnnMaxTau != null ? Hyperparams.ctrnnMaxTau : 8.0;
        const hiddenWithTau = HIDDEN_GRID.map(h => {
            const q = this.cppn.query(h.x, h.y, h.z, h.x, h.y, h.z, 0);
            const tNorm = (q.tau != null && Number.isFinite(q.tau)) ? q.tau : 0.5;
            const tau   = minTau + tNorm * (maxTau - minTau);
            return { ...h, tau };
        });
        g.setHiddenGrid(hiddenWithTau);

        this._node_coords = new Map(node_coords);
        for (const h of HIDDEN_GRID) {
            this._node_coords.set(h.id, { x: h.x, y: h.y, z: h.z });
        }

        const dietSet = this._getDietSet();
        const priorStrength = Hyperparams.cppnSeedPriorStrength != null
            ? Hyperparams.cppnSeedPriorStrength
            : 1.0;
        // A prior magnitude above this counts as "important", so we keep the
        // connection alive regardless of the LEO gate. Picked to cover the
        // 0.2 out-of-diet food penalty but ignore the small empty-bias unless
        // priorStrength makes it salient.
        const FORCE_EXPRESS_PRIOR_THRESHOLD = 0.15;

        const hidden_ids = HIDDEN_GRID.map(h => h.id);
        const pairs = [];
        for (const src of input_ids)  for (const dst of hidden_ids) pairs.push([src, dst]);
        for (const src of input_ids)  for (const dst of output_ids) pairs.push([src, dst]);
        for (const src of hidden_ids) for (const dst of output_ids) pairs.push([src, dst]);
        // Recurrent / lateral substrate edges — the CPPN can express them
        // (or not) on a per-pair basis via its LEO gate. Includes self-loops
        // when src === dst; those act as per-hidden memory weights.
        for (const src of hidden_ids) for (const dst of hidden_ids) pairs.push([src, dst]);

        // ── Pass 2: query each substrate connection for weight + LEO ──────
        for (const [src, dst] of pairs) {
            const sc = this._node_coords.get(src);
            const dc = this._node_coords.get(dst);
            if (!sc || !dc) continue;
            const dx = dc.x - sc.x, dy = dc.y - sc.y, dz = dc.z - sc.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) / COORD_DIST_NORM;
            const { weight, expressed } = this.cppn.query(
                sc.x, sc.y, sc.z, dc.x, dc.y, dc.z, distance
            );
            // Deterministic diet/feature-aware prior — zero for connections
            // whose source isn't a feature input we have domain knowledge about.
            const priorW = featurePriorWeight(src, dietSet) * priorStrength;
            const force = Math.abs(priorW) > FORCE_EXPRESS_PRIOR_THRESHOLD;
            if (!expressed && !force) continue;
            // CPPN weight output is tanh-bounded ∈ [-1, 1]; scale up to a
            // useful substrate range. Prior is additive so fresh CPPNs (near-
            // zero weight output) start out behaving like Phase-2 direct mode.
            g.addConnection(src, dst, weight * 2.0 + priorW);
        }
        this.genome = g;
    }

    /** Legacy Phase-2 substrate build: incremental setIO + diet-aware prior
     *  on freshly added I/O nodes. Used only when a save was loaded in
     *  "direct" encoding. */
    _buildSubstrateDirect(input_ids, output_ids) {
        const prev_inputs  = new Set(this.genome.inputs);
        const prev_outputs = new Set(this.genome.outputs);

        this.genome.setIO(input_ids, output_ids);

        const dietSet = this._getDietSet();
        const new_inputs  = input_ids.filter(id => !prev_inputs.has(id));
        const new_outputs = output_ids.filter(id => !prev_outputs.has(id));
        for (const src of new_inputs) {
            for (const dst of output_ids) {
                this.genome.addConnection(src, dst, dietAwarePriorWeight(src, dst, dietSet));
            }
        }
        if (new_outputs.length > 0) {
            for (const src of input_ids) {
                if (new_inputs.includes(src)) continue;
                for (const dst of new_outputs) {
                    this.genome.addConnection(src, dst, dietAwarePriorWeight(src, dst, dietSet));
                }
            }
        }
    }

    // ─── Brain interface ─────────────────────────────────────────────────

    observe(cell, distance, direction, eye_index, dx, dy) {
        const n_in = this.obs_buffer.length;
        if (n_in === 0) return;
        const base = eye_index * INPUTS_PER_EYE;
        if (base + INPUTS_PER_EYE > n_in) return;

        const feat = cellFeatureIndex(cell);
        for (let i = 0; i < N_CELL_FEATURES; i++) {
            this.obs_buffer[base + i] = (i === feat) ? 1.0 : 0.0;
        }
        const norm = Hyperparams.lookRange || 300;
        this.obs_buffer[base + N_CELL_FEATURES]     = Math.min(1.0, distance / norm);
        this.obs_buffer[base + N_CELL_FEATURES + 1] = (dx || 0) / norm;
        this.obs_buffer[base + N_CELL_FEATURES + 2] = (dy || 0) / norm;
    }

    decide() {
        const n_out = this.genome.outputs.length;
        const thrusts = new Float32Array(n_out);
        if (this.obs_buffer.length > 0 && n_out > 0) {
            const out = this.genome.forward(this.obs_buffer);
            for (let i = 0; i < n_out; i++) thrusts[i] = out[i];
        }
        this.obs_buffer.fill(0);
        this.last_thrusts = thrusts;
        return { thrusts };
    }

    mutate() {
        if (this.encoding === "cppn") {
            this._mutateCPPN();
        } else {
            this._mutateDirect();
        }

        // Mover direction mutation (same in both encodings — it's anatomical,
        // not part of the brain).
        for (const cell of this.owner.anatomy.cells) {
            if (cell.state === CellStates.mover && Math.random() < 0.1) {
                cell.direction = (cell.direction + (Math.random() < 0.5 ? 1 : 3)) % 4;
            }
        }
    }

    _mutateCPPN() {
        const strength = Hyperparams.nnMutationStrength || 0.05;
        this.cppn.perturbWeights(strength);

        const pAddConn = (Hyperparams.cppnAddConnectionProb    || 0) / 100;
        const pAddNode = (Hyperparams.cppnAddNodeProb          || 0) / 100;
        const pAct     = (Hyperparams.cppnMutateActivationProb || 0) / 100;
        const pDisable = (Hyperparams.cppnDisableConnectionProb|| 0) / 100;

        if (Math.random() < pAddConn) this.cppn.addRandomConnection();
        if (Math.random() < pAddNode) this.cppn.addRandomNode();
        if (Math.random() < pAct)     this.cppn.mutateRandomActivation();
        if (Math.random() < pDisable) this.cppn.disableRandomConnection();

        // The CPPN changed → resubstantiate the substrate so live decisions
        // reflect the new weights.
        this.buildSubstrate();
    }

    _mutateDirect() {
        const strength = Hyperparams.nnMutationStrength || 0.05;
        this.genome.perturbWeights(strength);
        const pAddConn = (Hyperparams.neatAddConnectionProb    || 0) / 100;
        const pAddNode = (Hyperparams.neatAddNodeProb          || 0) / 100;
        const pDisable = (Hyperparams.neatDisableConnectionProb|| 0) / 100;
        if (Math.random() < pAddConn) this._mutateAddConnection();
        if (Math.random() < pAddNode) this._mutateAddNode();
        if (Math.random() < pDisable) this.genome.disableRandomConnection();
    }

    _mutateAddConnection() {
        // Sample a legal (src, dst) pair: src from inputs/hiddens, dst from
        // hiddens/outputs, with hidden→hidden disallowed by Genome itself.
        const src_pool = [
            ...this.genome.inputs,
            ...this.genome.hiddens.map(h => h.id),
        ];
        const dst_pool = [
            ...this.genome.hiddens.map(h => h.id),
            ...this.genome.outputs,
        ];
        if (src_pool.length === 0 || dst_pool.length === 0) return;
        // A few attempts to find an unused legal pair before giving up. The
        // genome rejects invalid attempts silently.
        for (let attempt = 0; attempt < 8; attempt++) {
            const src = src_pool[(Math.random() * src_pool.length) | 0];
            const dst = dst_pool[(Math.random() * dst_pool.length) | 0];
            const conn = this.genome.addConnection(src, dst, gaussRandom() * 0.5);
            if (conn) return;
        }
    }

    _mutateAddNode() {
        // Pick a random enabled input→output connection. add_node only splits
        // those (the 1-hidden-layer rule).
        const candidates = this.genome.connections.filter(c =>
            c.enabled && c.src.startsWith("i:") && c.dst.startsWith("o:")
        );
        if (candidates.length === 0) return;
        const pick = candidates[(Math.random() * candidates.length) | 0];
        this.genome.addNodeOnConnection(pick);
    }

    copy(other) {
        if (other instanceof NNBrain) {
            this.encoding = other.encoding;
            if (other.encoding === "cppn") {
                other.cppn.cloneInto(this.cppn);
                // Rebuild this organism's substrate using the cloned CPPN.
                // We must do this AFTER copy() returns and anatomy is fully
                // assembled — Organism.inherit() rebuilds the substrate
                // explicitly when it's done. Until then, mirror the parent's
                // current substrate so observe/decide don't crash mid-copy.
                other.genome.cloneInto(this.genome);
            } else {
                other.genome.cloneInto(this.genome);
            }
            this.obs_buffer   = new Float32Array(this.genome.inputs.length);
            this.last_thrusts = new Float32Array(this.genome.outputs.length);
            this.eye_cell_count = other.eye_cell_count;
        } else {
            this.loadRaw(other);
        }
    }

    serialize() {
        const out = {
            type:   "nn",
            format: this.encoding === "cppn" ? "hyperneat-v1" : "neat-v1",
            genome: this.genome.serialize(),
        };
        if (this.encoding === "cppn") out.cppn = this.cppn.serialize();
        return out;
    }

    loadRaw(raw) {
        if (!raw || raw.type !== "nn") {
            this.buildSubstrate();
            return;
        }
        if (raw.format === "hyperneat-v1" && raw.cppn) {
            // Phase-3 HyperNEAT save. CPPN is the source of truth; genome is
            // a cache, so rebuild it from the CPPN after load.
            this.encoding = "cppn";
            this.cppn.loadFromSerialized(raw.cppn);
            this.buildSubstrate();
        } else if (raw.format === "neat-v1" && raw.genome) {
            // Phase-2 NEAT-v1 save — direct encoding, no CPPN. Stay in direct
            // mode for the rest of this organism's life.
            this.encoding = "direct";
            this.genome.loadFromSerialized(raw.genome);
        } else if (raw.w1 !== undefined && raw.w2 !== undefined) {
            // Phase-1 legacy w1/w2 save — also direct mode.
            this.encoding = "direct";
            this._loadFromTwoLayer(raw);
        } else {
            // Unknown — fall back to fresh CPPN.
            this.buildSubstrate();
            return;
        }
        this.obs_buffer   = new Float32Array(this.genome.inputs.length);
        this.last_thrusts = new Float32Array(this.genome.outputs.length);
    }

    /** Convert a legacy two-layer brain (Phase 1) into a Phase-2 genome.
     *  Each of the n_hidden middle neurons becomes an explicit hidden node,
     *  with one connection per (input, hidden) and (hidden, output) pair
     *  carrying the trained weights. No direct input→output skip links are
     *  created (Phase 1 didn't have any), so the loaded organism's behavior
     *  is bit-for-bit identical to the original under both forward passes. */
    _loadFromTwoLayer(raw) {
        const ni = raw.n_inputs  || 0;
        const nh = raw.n_hidden  || 0;
        const no = raw.n_outputs || 0;
        const w1 = raw.w1 || [];
        const w2 = raw.w2 || [];

        // The legacy format never recorded which eye each input came from. We
        // assume contiguous eye blocks of INPUTS_PER_EYE each, matching the
        // organism's anatomy.
        const n_eyes = ni / INPUTS_PER_EYE;
        const input_ids  = [];
        for (let e = 0; e < n_eyes; e++) {
            for (let f = 0; f < INPUTS_PER_EYE; f++) input_ids.push(inputId(e, f));
        }
        const output_ids = [];
        for (let m = 0; m < no; m++) output_ids.push(outputId(m));

        this.genome = new Genome();
        this.genome.inputs  = input_ids;
        this.genome.outputs = output_ids;
        for (let h = 0; h < nh; h++) {
            this.genome.hiddens.push({ id: "h:legacy-" + h, tau: 1.0, bias: 0.0 });
        }
        // input → hidden
        for (let i = 0; i < ni; i++) {
            for (let h = 0; h < nh; h++) {
                const src = input_ids[i];
                const dst = "h:legacy-" + h;
                this.genome.addConnection(src, dst, w1[i * nh + h] || 0);
            }
        }
        // hidden → output
        for (let h = 0; h < nh; h++) {
            for (let o = 0; o < no; o++) {
                const src = "h:legacy-" + h;
                const dst = output_ids[o];
                this.genome.addConnection(src, dst, w2[h * no + o] || 0);
            }
        }
    }

    checkAddedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate();
        }
    }

    checkRemovedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate(cell);
        }
    }

    onDietChanged() {
        // In CPPN mode the diet-aware prior is blended in at build time, so a
        // mouth diet change requires a rebuild for the new prior to take
        // effect. In direct mode existing trained weights are preserved.
        if (this.encoding === "cppn") {
            this.buildSubstrate();
        }
    }

    size() {
        return this.genome.numEnabledConnections();
    }

    // ─── FSM editor compatibility stubs ──────────────────────────────────
    get num_states() { return 0; }
    get state()      { return 0; }
    get independent_eye_decisions() { return false; }
    get decisions()  { return []; }
    countCells() {
        this.eye_cell_count = 0;
        for (const c of this.owner.anatomy.cells) {
            if (c.state === CellStates.eye) this.eye_cell_count++;
        }
    }
    setIndependentEyeDecisions() {}
    newBrainState() {}
    removeBrainState() {}

    /** Fresh draw for new founders. In CPPN mode, mint a new CPPN and rebuild
     *  the substrate from it. In direct mode, reroll connection weights from
     *  the diet-aware prior. */
    randomizeDecisions() {
        if (this.encoding === "cppn") {
            this.cppn = new CPPN();
            this.buildSubstrate();
            return;
        }
        const dietSet = this._getDietSet();
        for (const c of this.genome.connections) {
            c.weight = dietAwarePriorWeight(c.src, c.dst, dietSet);
        }
        this.genome._compiled = null;
    }
}

// Re-exports for tests and overlay code that imported the feature constants.
NNBrain.INPUTS_PER_EYE  = INPUTS_PER_EYE;
NNBrain.N_CELL_FEATURES = N_CELL_FEATURES;

module.exports = NNBrain;
