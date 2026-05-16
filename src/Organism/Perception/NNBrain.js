const Hyperparams = require("../../Hyperparameters");
const CellStates = require("../Cell/CellStates");
const Brain = require("./Brain");

// Feature indices per eye observation.
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

// Map a grid cell to its feature index.
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

class NNBrain extends Brain {
    constructor(owner) {
        super();
        this.owner = owner;
        // Two-layer network: input → hidden → output
        this.w1 = new Float32Array(0);   // n_inputs  × n_hidden
        this.w2 = new Float32Array(0);   // n_hidden  × n_outputs
        this.n_inputs  = 0;
        this.n_hidden  = 0;
        this.n_outputs = 0;
        this.obs_buffer    = new Float32Array(0);
        this.hidden_buffer = new Float32Array(0);
        this.last_thrusts  = new Float32Array(0);
        this.eye_cell_count = 0;
        this.buildSubstrate();
    }

    // Collect the set of food type IDs that this organism's mouth cells eat.
    _getDietSet() {
        const diet = new Set();
        for (const c of this.owner.anatomy.cells) {
            if (c.state === CellStates.mouth && typeof c.diet === 'number') {
                diet.add(c.diet);
            }
        }
        return diet;
    }

    buildSubstrate(excludeCell = null) {
        let n_eyes = 0;
        let n_movers = 0;
        for (const c of this.owner.anatomy.cells) {
            if (c === excludeCell) continue;
            if (c.state === CellStates.eye)        n_eyes++;
            else if (c.state === CellStates.mover) n_movers++;
        }
        this.eye_cell_count = n_eyes;

        const new_n_inputs  = n_eyes * INPUTS_PER_EYE;
        const new_n_outputs = n_movers;
        // hidden layer is only meaningful when both inputs and outputs exist
        const new_n_hidden  = (new_n_inputs > 0 && new_n_outputs > 0) ? (Hyperparams.nnHiddenSize || 4) : 0;

        const inputs_changed  = new_n_inputs  !== this.n_inputs;
        const hidden_changed  = new_n_hidden  !== this.n_hidden;
        const outputs_changed = new_n_outputs !== this.n_outputs;

        if (!inputs_changed && !hidden_changed && !outputs_changed) return;

        const dietSet = this._getDietSet();
        const hasDiet = dietSet.size > 0;

        // ── resize w1 (n_inputs × n_hidden) ──────────────────────────────────
        if (inputs_changed || hidden_changed) {
            const old_w1  = this.w1;
            const old_ni  = this.n_inputs;
            const old_nh  = this.n_hidden;
            const new_w1  = new Float32Array(new_n_inputs * new_n_hidden);
            const min_ni  = Math.min(old_ni, new_n_inputs);
            const min_nh  = Math.min(old_nh, new_n_hidden);

            // preserve the overlapping weight block from the old matrix
            for (let i = 0; i < min_ni; i++) {
                for (let h = 0; h < min_nh; h++) {
                    new_w1[i * new_n_hidden + h] = old_w1[i * old_nh + h];
                }
            }

            // initialise new connections with diet-aware prior
            for (let i = 0; i < new_n_inputs; i++) {
                for (let h = 0; h < new_n_hidden; h++) {
                    if (i < min_ni && h < min_nh) continue; // already copied
                    const feature = i % INPUTS_PER_EYE;
                    if (feature >= FEAT_FOOD_0 && feature <= FEAT_FOOD_3) {
                        const foodType = feature - FEAT_FOOD_0;
                        new_w1[i * new_n_hidden + h] = hasDiet
                            ? (dietSet.has(foodType) ? 1.0 : 0.1)
                            : gaussRandom() * 0.1;
                    } else if (feature === FEAT_KILLER) {
                        new_w1[i * new_n_hidden + h] = -1.0;
                    } else if (feature === FEAT_EMPTY) {
                        new_w1[i * new_n_hidden + h] = 0.3;
                    } else {
                        new_w1[i * new_n_hidden + h] = gaussRandom() * 0.1;
                    }
                }
            }
            this.w1 = new_w1;
        }

        // ── resize w2 (n_hidden × n_outputs) ─────────────────────────────────
        if (hidden_changed || outputs_changed) {
            const old_w2  = this.w2;
            const old_nh  = this.n_hidden;
            const old_no  = this.n_outputs;
            const new_w2  = new Float32Array(new_n_hidden * new_n_outputs);
            const min_nh  = Math.min(old_nh, new_n_hidden);
            const min_no  = Math.min(old_no, new_n_outputs);

            for (let h = 0; h < min_nh; h++) {
                for (let j = 0; j < min_no; j++) {
                    new_w2[h * new_n_outputs + j] = old_w2[h * old_no + j];
                }
            }

            // new hidden→output connections: small positive bias so food-chasing
            // hidden activations immediately translate to forward thrust
            for (let h = 0; h < new_n_hidden; h++) {
                for (let j = 0; j < new_n_outputs; j++) {
                    if (h < min_nh && j < min_no) continue;
                    new_w2[h * new_n_outputs + j] = gaussRandom() * 0.1 + 0.5;
                }
            }
            this.w2 = new_w2;
        }

        this.n_inputs      = new_n_inputs;
        this.n_hidden      = new_n_hidden;
        this.n_outputs     = new_n_outputs;
        this.obs_buffer    = new Float32Array(new_n_inputs);
        this.hidden_buffer = new Float32Array(new_n_hidden);
        this.last_thrusts  = new Float32Array(new_n_outputs);
    }

    observe(cell, distance, direction, eye_index, dx, dy) {
        if (this.n_inputs === 0) return;
        const base = eye_index * INPUTS_PER_EYE;
        if (base + INPUTS_PER_EYE > this.n_inputs) return;

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
        const thrusts = new Float32Array(this.n_outputs);
        if (this.n_inputs > 0 && this.n_hidden > 0 && this.n_outputs > 0) {
            // hidden = tanh(w1 @ obs)
            for (let h = 0; h < this.n_hidden; h++) {
                let sum = 0;
                for (let i = 0; i < this.n_inputs; i++) {
                    sum += this.w1[i * this.n_hidden + h] * this.obs_buffer[i];
                }
                this.hidden_buffer[h] = Math.tanh(sum);
            }
            // output = tanh(w2 @ hidden)
            for (let j = 0; j < this.n_outputs; j++) {
                let sum = 0;
                for (let h = 0; h < this.n_hidden; h++) {
                    sum += this.w2[h * this.n_outputs + j] * this.hidden_buffer[h];
                }
                thrusts[j] = Math.tanh(sum);
            }
        }
        this.obs_buffer.fill(0);
        this.last_thrusts = thrusts;
        return { thrusts };
    }

    mutate() {
        const strength = Hyperparams.nnMutationStrength || 0.05;
        for (let i = 0; i < this.w1.length; i++) {
            this.w1[i] += gaussRandom() * strength;
            if (this.w1[i] > 3)       this.w1[i] = 3;
            else if (this.w1[i] < -3) this.w1[i] = -3;
        }
        for (let i = 0; i < this.w2.length; i++) {
            this.w2[i] += gaussRandom() * strength;
            if (this.w2[i] > 3)       this.w2[i] = 3;
            else if (this.w2[i] < -3) this.w2[i] = -3;
        }
        for (const cell of this.owner.anatomy.cells) {
            if (cell.state === CellStates.mover && Math.random() < 0.1) {
                cell.direction = (cell.direction + (Math.random() < 0.5 ? 1 : 3)) % 4;
            }
        }
    }

    copy(other) {
        if (other instanceof NNBrain) {
            this.n_inputs      = other.n_inputs;
            this.n_hidden      = other.n_hidden;
            this.n_outputs     = other.n_outputs;
            this.w1            = new Float32Array(other.w1);
            this.w2            = new Float32Array(other.w2);
            this.hidden_buffer = new Float32Array(this.n_hidden);
            this.obs_buffer    = new Float32Array(this.n_inputs);
            this.last_thrusts  = new Float32Array(this.n_outputs);
            this.eye_cell_count = other.eye_cell_count;
        } else {
            this.loadRaw(other);
        }
    }

    serialize() {
        return {
            type:      'nn',
            n_inputs:  this.n_inputs,
            n_hidden:  this.n_hidden,
            n_outputs: this.n_outputs,
            w1:        Array.from(this.w1),
            w2:        Array.from(this.w2),
        };
    }

    loadRaw(raw) {
        if (!raw || raw.type !== 'nn') {
            this.buildSubstrate();
            return;
        }
        if (raw.w1 !== undefined) {
            // current two-layer format
            this.n_inputs      = raw.n_inputs  || 0;
            this.n_hidden      = raw.n_hidden  || 0;
            this.n_outputs     = raw.n_outputs || 0;
            this.w1            = new Float32Array(raw.w1 || []);
            this.w2            = new Float32Array(raw.w2 || []);
            this.hidden_buffer = new Float32Array(this.n_hidden);
            this.obs_buffer    = new Float32Array(this.n_inputs);
            this.last_thrusts  = new Float32Array(this.n_outputs);
        } else {
            // old single-matrix format — rebuild with current Hyperparams.nnHiddenSize
            this.buildSubstrate();
        }
    }

    checkAddedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate();
        }
    }

    checkRemovedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate(cell); // pass cell so it is excluded from count before splice
        }
    }

    // Called when a mouth cell's diet changes so the prior is refreshed
    // on any unlearned (zero-initialised) connections.
    onDietChanged() {
        this.buildSubstrate();
    }

    size() { return this.w1.length + this.w2.length; }

    // --- FSM editor compatibility stubs ---
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

    randomizeDecisions() {
        const dietSet = this._getDietSet();
        const hasDiet = dietSet.size > 0;
        for (let i = 0; i < this.w1.length; i++) {
            const feature = Math.floor(i / (this.n_hidden || 1)) % INPUTS_PER_EYE;
            if (feature >= FEAT_FOOD_0 && feature <= FEAT_FOOD_3) {
                const foodType = feature - FEAT_FOOD_0;
                if (hasDiet) {
                    this.w1[i] = dietSet.has(foodType) ? 1.0 + gaussRandom() * 0.2 : -0.2 + gaussRandom() * 0.1;
                } else {
                    this.w1[i] = gaussRandom() * 0.2;
                }
            } else if (feature === FEAT_KILLER) {
                this.w1[i] = -1.0 + gaussRandom() * 0.2;
            } else {
                this.w1[i] = gaussRandom() * 0.2;
            }
        }
        for (let i = 0; i < this.w2.length; i++) {
            this.w2[i] = gaussRandom() * 0.2 + 0.5;
        }
    }
}

module.exports = NNBrain;
