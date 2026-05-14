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
        this.weights = new Float32Array(0);
        this.n_inputs = 0;
        this.n_outputs = 0;
        this.obs_buffer = new Float32Array(0);
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
            if (c.state === CellStates.eye)   n_eyes++;
            else if (c.state === CellStates.mover) n_movers++;
        }
        this.eye_cell_count = n_eyes;

        const new_n_inputs  = n_eyes * INPUTS_PER_EYE;
        const new_n_outputs = n_movers;

        if (new_n_inputs === this.n_inputs && new_n_outputs === this.n_outputs) return;

        const old_weights = this.weights;
        const old_size    = this.n_inputs * this.n_outputs;
        const new_size    = new_n_inputs  * new_n_outputs;

        this.n_inputs  = new_n_inputs;
        this.n_outputs = new_n_outputs;

        const new_weights = new Float32Array(new_size);
        const preserve    = Math.min(old_size, new_size);
        for (let i = 0; i < preserve; i++) new_weights[i] = old_weights[i];

        // Initialise new connections with a diet-aware prior:
        //   - Food type in diet  → +1.0  (chase)
        //   - Food type not in diet → -0.2 (mild avoidance if organism has a diet, else noise)
        //   - Killer             → -1.0  (flee)
        //   - Everything else   → small gaussian noise
        const dietSet = this._getDietSet();
        const hasDiet = dietSet.size > 0;

        for (let i = preserve; i < new_size; i++) {
            const feature = Math.floor(i / new_n_outputs) % INPUTS_PER_EYE;
            if (feature >= FEAT_FOOD_0 && feature <= FEAT_FOOD_3) {
                const foodType = feature - FEAT_FOOD_0;
                if (hasDiet) {
                    new_weights[i] = dietSet.has(foodType) ? 1.0 : -0.2;
                } else {
                    new_weights[i] = gaussRandom() * 0.1;
                }
            } else if (feature === FEAT_KILLER) {
                new_weights[i] = -1.0;
            } else {
                new_weights[i] = gaussRandom() * 0.1;
            }
        }

        this.weights   = new_weights;
        this.obs_buffer = new Float32Array(this.n_inputs);
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
        if (this.n_inputs > 0 && this.n_outputs > 0) {
            for (let j = 0; j < this.n_outputs; j++) {
                let sum = 0;
                for (let i = 0; i < this.n_inputs; i++) {
                    sum += this.weights[i * this.n_outputs + j] * this.obs_buffer[i];
                }
                thrusts[j] = Math.tanh(sum);
            }
        }
        this.obs_buffer.fill(0);
        return { thrusts };
    }

    mutate() {
        const strength = Hyperparams.nnMutationStrength || 0.05;
        for (let i = 0; i < this.weights.length; i++) {
            this.weights[i] += gaussRandom() * strength;
            if (this.weights[i] > 3)  this.weights[i] = 3;
            else if (this.weights[i] < -3) this.weights[i] = -3;
        }
        for (const cell of this.owner.anatomy.cells) {
            if (cell.state === CellStates.mover && Math.random() < 0.1) {
                cell.direction = (cell.direction + (Math.random() < 0.5 ? 1 : 3)) % 4;
            }
        }
    }

    copy(other) {
        if (other instanceof NNBrain) {
            this.n_inputs       = other.n_inputs;
            this.n_outputs      = other.n_outputs;
            this.weights        = new Float32Array(other.weights);
            this.obs_buffer     = new Float32Array(this.n_inputs);
            this.eye_cell_count = other.eye_cell_count;
        } else {
            this.loadRaw(other);
        }
    }

    serialize() {
        return {
            type: 'nn',
            weights:   Array.from(this.weights),
            n_inputs:  this.n_inputs,
            n_outputs: this.n_outputs
        };
    }

    loadRaw(raw) {
        if (!raw || raw.type !== 'nn') {
            this.buildSubstrate();
            return;
        }
        this.n_inputs  = raw.n_inputs  || 0;
        this.n_outputs = raw.n_outputs || 0;
        this.weights   = new Float32Array(raw.weights || []);
        this.obs_buffer = new Float32Array(this.n_inputs);
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

    size() { return this.weights.length; }

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
        for (let i = 0; i < this.weights.length; i++) {
            const feature = Math.floor(i / this.n_outputs) % INPUTS_PER_EYE;
            if (feature >= FEAT_FOOD_0 && feature <= FEAT_FOOD_3) {
                const foodType = feature - FEAT_FOOD_0;
                if (hasDiet) {
                    this.weights[i] = dietSet.has(foodType) ? 1.0 + gaussRandom() * 0.2 : -0.2 + gaussRandom() * 0.1;
                } else {
                    this.weights[i] = gaussRandom() * 0.2;
                }
            } else if (feature === FEAT_KILLER) {
                this.weights[i] = -1.0 + gaussRandom() * 0.2;
            } else {
                this.weights[i] = gaussRandom() * 0.2;
            }
        }
    }
}

module.exports = NNBrain;
