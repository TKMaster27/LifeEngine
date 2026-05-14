const Hyperparams = require("../../Hyperparameters");
const CellStates = require("../Cell/CellStates");
const Brain = require("./Brain");

// Build a stable name→index map once from CellStates.all so one-hot encoding is deterministic.
// The 10 states (in order): empty, food, wall, mouth, producer, emitter, mover, killer, armor, eye
const CELL_STATE_INDEX = {};
CellStates.all.forEach((s, i) => { CELL_STATE_INDEX[s.name] = i; });
const N_CELL_TYPES = CellStates.all.length; // 10

// Inputs per eye: N_CELL_TYPES one-hot + normalised distance + dx + dy = 13
const INPUTS_PER_EYE = N_CELL_TYPES + 3;

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
        // compatibility stubs for EditorController (FSM brain editor gracefully shows nothing)
        this.eye_cell_count = 0;
        this.buildSubstrate();
    }

    buildSubstrate() {
        let n_eyes = 0;
        let n_movers = 0;
        for (const c of this.owner.anatomy.cells) {
            if (c.state === CellStates.eye) n_eyes++;
            else if (c.state === CellStates.mover) n_movers++;
        }
        this.eye_cell_count = n_eyes;

        const new_n_inputs = n_eyes * INPUTS_PER_EYE;
        const new_n_outputs = n_movers;

        if (new_n_inputs === this.n_inputs && new_n_outputs === this.n_outputs) return;

        const old_weights = this.weights;
        const old_size = this.n_inputs * this.n_outputs;
        const new_size = new_n_inputs * new_n_outputs;

        this.n_inputs = new_n_inputs;
        this.n_outputs = new_n_outputs;

        const new_weights = new Float32Array(new_size);
        const preserve = Math.min(old_size, new_size);
        for (let i = 0; i < preserve; i++) {
            new_weights[i] = old_weights[i];
        }
        // new connections initialised with a "chase food, flee killers" prior so fresh organisms
        // start with sensible directed behaviour rather than frozen random noise.
        const FOOD_FEATURE   = CELL_STATE_INDEX['food'];   // 1
        const KILLER_FEATURE = CELL_STATE_INDEX['killer']; // 7
        for (let i = preserve; i < new_size; i++) {
            const feature = Math.floor(i / new_n_outputs) % INPUTS_PER_EYE;
            if (feature === FOOD_FEATURE)        new_weights[i] = 1.0;
            else if (feature === KILLER_FEATURE) new_weights[i] = -1.0;
            else                                 new_weights[i] = gaussRandom() * 0.1;
        }
        this.weights = new_weights;
        this.obs_buffer = new Float32Array(this.n_inputs);
    }

    observe(cell, distance, direction, eye_index, dx, dy) {
        if (this.n_inputs === 0) return;
        const base = eye_index * INPUTS_PER_EYE;
        if (base + INPUTS_PER_EYE > this.n_inputs) return;

        const state = (cell && cell.state) ? cell.state : CellStates.empty;
        const one_hot_idx = CELL_STATE_INDEX[state.name] ?? 0;

        for (let i = 0; i < N_CELL_TYPES; i++) {
            this.obs_buffer[base + i] = (i === one_hot_idx) ? 1.0 : 0.0;
        }
        const norm = Hyperparams.lookRange || 300;
        this.obs_buffer[base + N_CELL_TYPES]     = Math.min(1.0, distance / norm);
        this.obs_buffer[base + N_CELL_TYPES + 1] = (dx || 0) / norm;
        this.obs_buffer[base + N_CELL_TYPES + 2] = (dy || 0) / norm;
    }

    decide() {
        const thrusts = new Float32Array(this.n_outputs);
        if (this.n_inputs > 0 && this.n_outputs > 0) {
            // forward pass: thrusts[j] = tanh(Σ_i weights[i * n_outputs + j] * obs[i])
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
            if (this.weights[i] > 3) this.weights[i] = 3;
            else if (this.weights[i] < -3) this.weights[i] = -3;
        }
        // mover direction mutates with low probability
        for (const cell of this.owner.anatomy.cells) {
            if (cell.state === CellStates.mover && Math.random() < 0.1) {
                cell.direction = (cell.direction + (Math.random() < 0.5 ? 1 : 3)) % 4;
            }
        }
    }

    copy(other) {
        // other may be an NNBrain instance (from inheritance) or a raw serialized object (from loadRaw)
        if (other instanceof NNBrain) {
            this.n_inputs = other.n_inputs;
            this.n_outputs = other.n_outputs;
            this.weights = new Float32Array(other.weights);
            this.obs_buffer = new Float32Array(this.n_inputs);
            this.eye_cell_count = other.eye_cell_count;
        } else {
            this.loadRaw(other);
        }
    }

    serialize() {
        return {
            type: 'nn',
            weights: Array.from(this.weights),
            n_inputs: this.n_inputs,
            n_outputs: this.n_outputs
        };
    }

    loadRaw(raw) {
        if (!raw || raw.type !== 'nn') {
            // unrecognised (e.g. old FSM save) — rebuild from anatomy
            this.buildSubstrate();
            return;
        }
        this.n_inputs = raw.n_inputs || 0;
        this.n_outputs = raw.n_outputs || 0;
        this.weights = new Float32Array(raw.weights || []);
        this.obs_buffer = new Float32Array(this.n_inputs);
    }

    checkAddedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate();
        }
    }

    checkRemovedCell(cell) {
        if (cell.state === CellStates.eye || cell.state === CellStates.mover) {
            this.buildSubstrate();
        }
    }

    size() {
        return this.weights.length;
    }

    // --- FSM editor compatibility stubs (prevent EditorController crashes) ---
    get num_states() { return 0; }
    get state() { return 0; }
    get independent_eye_decisions() { return false; }
    get decisions() { return []; }
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
        const FOOD_FEATURE   = CELL_STATE_INDEX['food'];
        const KILLER_FEATURE = CELL_STATE_INDEX['killer'];
        for (let i = 0; i < this.weights.length; i++) {
            const feature = Math.floor(i / this.n_outputs) % INPUTS_PER_EYE;
            if (feature === FOOD_FEATURE)        this.weights[i] = 1.0  + gaussRandom() * 0.2;
            else if (feature === KILLER_FEATURE) this.weights[i] = -1.0 + gaussRandom() * 0.2;
            else                                 this.weights[i] = gaussRandom() * 0.2;
        }
    }
}

module.exports = NNBrain;
