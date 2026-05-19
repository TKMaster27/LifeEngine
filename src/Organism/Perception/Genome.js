// NEAT-style genome for Phase 2.
//
// Hard architectural rule: at most ONE hidden layer.
//   - Allowed connections:  input → hidden, input → output, hidden → output.
//   - Forbidden:            hidden → hidden, any → input, output → any.
//   - add_node only splits  input → output  connections (anything else would
//                          deepen the network and is rejected).
//
// This rule means the forward pass is always exactly:
//     inputs → (hiddens + direct input→output skips) → outputs
// so we don't need a topological sort; a 3-stage walk over compiled arrays is
// enough and stays fast enough to run thousands of organisms per tick.
//
// Node id namespace (strings):
//   "i:<eye_index>:<feat_index>"   inputs, deterministic from anatomy
//   "o:<mover_index>"              outputs, deterministic from anatomy
//   "h:<n>"                        hidden nodes, minted by Innovation.nextHiddenId()
//
// Hidden nodes carry placeholder `tau` and `bias` fields so Phase 4 (CTRNN)
// can plug a leaky-integrator step in without changing the file format.

const Innovation  = require("./Innovation");
const Hyperparams = require("../../Hyperparameters");

function gaussRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const WEIGHT_CLAMP = 3.0;
function clampWeight(w) {
    if (w >  WEIGHT_CLAMP) return  WEIGHT_CLAMP;
    if (w < -WEIGHT_CLAMP) return -WEIGHT_CLAMP;
    return w;
}

class Genome {
    constructor() {
        // Node id arrays in insertion order. Anatomy-derived (input/output)
        // ids are deterministic; hidden ids come from Innovation.
        this.inputs  = [];           // string ids
        this.outputs = [];           // string ids
        this.hiddens = [];           // [{ id, tau, bias }]

        // Connections in insertion order (== innovation order for connections
        // first created by this genome). { innovation_id, src, dst, weight, enabled }.
        this.connections = [];

        // CTRNN per-hidden state (membrane potential). Persistent across
        // forward() calls within the same organism's lifetime — this is what
        // gives the network "thought momentum". Zeroed on construction,
        // resized whenever hiddens.length changes, and reset to zero on
        // cloneInto() so offspring start with a clean slate.
        this._hidden_state = new Float32Array(0);

        // Compiled-form caches. Rebuilt by _recompile() after any structural change.
        this._compiled = null;
    }

    /** Resize / zero `_hidden_state` to match current hiddens.length. */
    _resyncHiddenState() {
        if (this._hidden_state.length !== this.hiddens.length) {
            this._hidden_state = new Float32Array(this.hiddens.length);
        }
    }

    /** Zero the CTRNN state — called at birth so offspring don't inherit
     *  membrane potentials from their parents. */
    resetState() {
        this._hidden_state.fill(0);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Structure mutation primitives — each enforces the 1-hidden-layer rule.
    // ─────────────────────────────────────────────────────────────────────

    /** Returns the node type for a given id, or null if the node is not in
     *  this genome. */
    _nodeType(id) {
        if (this.inputs.includes(id))  return "input";
        if (this.outputs.includes(id)) return "output";
        if (this.hiddens.some(h => h.id === id)) return "hidden";
        return null;
    }

    /** Returns true iff a (src, dst) pair is a legal connection target under
     *  the 1-hidden-layer rule. */
    _legalConnectionPair(src, dst) {
        const st = this._nodeType(src);
        const dt = this._nodeType(dst);
        if (st === null || dt === null)        return false;
        if (st === "output")                   return false;   // no fan-out from outputs
        if (dt === "input")                    return false;   // no fan-in to inputs
        if (st === "hidden" && dt === "hidden")return false;   // no lateral
        if (src === dst)                       return false;   // no self-loops
        return true;
    }

    _findConnection(src, dst) {
        return this.connections.find(c => c.src === src && c.dst === dst);
    }

    /** Add a connection. No-op if (src,dst) already exists OR pair is illegal.
     *  Returns the connection object on success, null otherwise. */
    addConnection(src, dst, weight) {
        if (!this._legalConnectionPair(src, dst)) return null;
        if (this._findConnection(src, dst)) return null;
        const conn = {
            innovation_id: Innovation.getConnectionId(src, dst),
            src, dst,
            weight:  clampWeight(weight),
            enabled: true,
        };
        this.connections.push(conn);
        this._compiled = null;
        return conn;
    }

    /** Split an existing input→output connection by inserting a new hidden
     *  node. The original connection is disabled (kept for innovation lineage),
     *  and two new connections are created:
     *     src → new_hidden  (weight 1.0, preserves signal magnitude)
     *     new_hidden → dst  (weight = old weight)
     *  Returns the new hidden node, or null if the split would violate the
     *  1-hidden-layer rule. */
    addNodeOnConnection(conn) {
        if (!conn || !conn.enabled) return null;
        // Only allow splitting input→output. Splitting input→hidden or
        // hidden→output would create a second hidden layer.
        if (this._nodeType(conn.src) !== "input")  return null;
        if (this._nodeType(conn.dst) !== "output") return null;

        const hidden_id  = Innovation.nextHiddenId();
        const defaultTau = Hyperparams.ctrnnDefaultTau != null ? Hyperparams.ctrnnDefaultTau : 1.0;
        const new_hidden = { id: hidden_id, tau: defaultTau, bias: 0.0 };
        this.hiddens.push(new_hidden);
        this._resyncHiddenState();

        conn.enabled = false;

        const in_conn = {
            innovation_id: Innovation.getConnectionId(conn.src, hidden_id),
            src: conn.src, dst: hidden_id, weight: 1.0, enabled: true,
        };
        const out_conn = {
            innovation_id: Innovation.getConnectionId(hidden_id, conn.dst),
            src: hidden_id, dst: conn.dst, weight: clampWeight(conn.weight), enabled: true,
        };
        this.connections.push(in_conn, out_conn);
        this._compiled = null;
        return new_hidden;
    }

    /** Perturb every enabled connection's weight by gaussian noise of given
     *  strength. Independent perturbation each call. */
    perturbWeights(strength) {
        for (const conn of this.connections) {
            if (!conn.enabled) continue;
            conn.weight = clampWeight(conn.weight + gaussRandom() * strength);
        }
        // Compiled weights are derived from conn.weight, so a recompile is
        // only strictly needed if we cache weights separately. We do — flag it.
        this._compiled = null;
    }

    /** Disable a uniformly-chosen enabled connection. No-op if there are none. */
    disableRandomConnection() {
        const enabled = this.connections.filter(c => c.enabled);
        if (enabled.length === 0) return null;
        const pick = enabled[(Math.random() * enabled.length) | 0];
        pick.enabled = false;
        this._compiled = null;
        return pick;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Anatomy-driven changes (not NEAT mutations — bookkeeping on cell add/remove).
    // ─────────────────────────────────────────────────────────────────────

    /** Replace input and output sets. Connections referencing nodes that no
     *  longer exist are pruned. Returns the number of pruned connections. */
    setIO(input_ids, output_ids) {
        this.inputs  = input_ids.slice();
        this.outputs = output_ids.slice();
        const valid_ids = new Set([
            ...this.inputs,
            ...this.outputs,
            ...this.hiddens.map(h => h.id),
        ]);
        const before = this.connections.length;
        this.connections = this.connections.filter(c =>
            valid_ids.has(c.src) && valid_ids.has(c.dst)
        );
        const pruned = before - this.connections.length;
        // Drop hiddens that lost all connectivity. A hidden with no incoming or
        // no outgoing is functionally dead weight; pruning keeps the genome lean.
        this.hiddens = this.hiddens.filter(h => {
            const has_in  = this.connections.some(c => c.dst === h.id && c.enabled);
            const has_out = this.connections.some(c => c.src === h.id && c.enabled);
            return has_in && has_out;
        });
        // After dropping hiddens, drop any connections that mentioned them.
        const live_hidden = new Set(this.hiddens.map(h => h.id));
        this.connections = this.connections.filter(c => {
            const sh = c.src.startsWith("h:");
            const dh = c.dst.startsWith("h:");
            if (sh && !live_hidden.has(c.src)) return false;
            if (dh && !live_hidden.has(c.dst)) return false;
            return true;
        });
        this._resyncHiddenState();
        this._compiled = null;
        return pruned;
    }

    /** Add every input→output connection that does not already exist, using
     *  weight_fn(src_id, dst_id) → number to pick each weight. Used for the
     *  pure-NEAT minimal initial topology (no hidden nodes). */
    seedFullyConnected(weight_fn) {
        for (const src of this.inputs) {
            for (const dst of this.outputs) {
                if (this._findConnection(src, dst)) continue;
                this.addConnection(src, dst, weight_fn(src, dst));
            }
        }
    }

    /** Install a fixed substrate hidden layer. The hidden nodes carry their
     *  substrate coordinates so the CPPN (Phase 3+) can query the weight for
     *  any (src, dst) pair using geometric inputs.
     *
     *  Used in HyperNEAT mode. The grid nodes are NOT pruned by setIO. */
    setHiddenGrid(grid_nodes) {
        // grid_nodes: [{ id, x, y, z, tau?, bias? }]
        const defaultTau = Hyperparams.ctrnnDefaultTau != null ? Hyperparams.ctrnnDefaultTau : 1.0;
        this.hiddens = grid_nodes.map(h => ({
            id:   h.id,
            x:    h.x, y: h.y, z: h.z != null ? h.z : 0,
            tau:  h.tau  != null ? h.tau  : defaultTau,
            bias: h.bias != null ? h.bias : 0.0,
            grid: true,
        }));
        this._resyncHiddenState();
        this._compiled = null;
    }

    /** Like setIO but tailored to HyperNEAT: keep the fixed hidden grid
     *  (set via setHiddenGrid) regardless of whether its incoming/outgoing
     *  connections are populated yet. */
    setIOPreservingHiddens(input_ids, output_ids) {
        this.inputs  = input_ids.slice();
        this.outputs = output_ids.slice();
        const valid_ids = new Set([
            ...this.inputs,
            ...this.outputs,
            ...this.hiddens.map(h => h.id),
        ]);
        this.connections = this.connections.filter(c =>
            valid_ids.has(c.src) && valid_ids.has(c.dst)
        );
        this._resyncHiddenState();
        this._compiled = null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Compilation + forward pass.
    // ─────────────────────────────────────────────────────────────────────

    _recompile() {
        const idx = new Map();
        let i = 0;
        for (const id of this.inputs)  idx.set(id, i++);
        const hidden_offset = i;
        for (const h  of this.hiddens) idx.set(h.id, i++);
        const output_offset = i;
        for (const id of this.outputs) idx.set(id, i++);
        const n_total = i;

        const incoming_hidden = this.hiddens.map(() => []);
        const incoming_output = this.outputs.map(() => []);
        for (const conn of this.connections) {
            if (!conn.enabled) continue;
            const src_index = idx.get(conn.src);
            const dst_index = idx.get(conn.dst);
            if (src_index === undefined || dst_index === undefined) continue;
            if (dst_index >= output_offset) {
                incoming_output[dst_index - output_offset].push({ src_index, weight: conn.weight });
            } else if (dst_index >= hidden_offset) {
                incoming_hidden[dst_index - hidden_offset].push({ src_index, weight: conn.weight });
            }
            // dst < hidden_offset would mean a connection into an input — already
            // forbidden by _legalConnectionPair, but skip defensively.
        }

        this._compiled = {
            n_inputs:        this.inputs.length,
            n_hiddens:       this.hiddens.length,
            n_outputs:       this.outputs.length,
            hidden_offset,
            output_offset,
            n_total,
            activations:     new Float32Array(n_total),
            hidden_biases:   Float32Array.from(this.hiddens.map(h => h.bias || 0)),
            hidden_taus:     Float32Array.from(this.hiddens.map(h => h.tau  != null ? h.tau : 1.0)),
            incoming_hidden,
            incoming_output,
        };
    }

    /** Forward pass. `obs_buffer` is a Float32Array of length n_inputs whose
     *  entries are indexed in the same order as this.inputs. Returns a
     *  Float32Array of length n_outputs (a *subarray view* into the compiled
     *  activations buffer — copy it if you intend to retain it beyond the next
     *  forward call).
     *
     *  When CTRNN is enabled (the Phase-4 default), each hidden node carries
     *  membrane-potential state across calls:
     *      y_h(t+1) = (1 − α) · y_h(t) + α · Σ w_hj · activation_j
     *      activation_h = tanh(y_h(t+1) + θ_h)        α = clamp(dt/τ_h, 0, 1)
     *  With τ_h = 1 this collapses to pure feedforward — i.e. setting
     *  ctrnnEnabled=false or every τ=1 reproduces Phase-3 behaviour exactly. */
    forward(obs_buffer) {
        if (this._compiled === null) this._recompile();
        const c = this._compiled;
        const acts = c.activations;
        const state = this._hidden_state;

        const ctrnnOn = Hyperparams.ctrnnEnabled !== false;
        const dt      = Hyperparams.ctrnnDt     != null ? Hyperparams.ctrnnDt     : 1.0;
        const minTau  = Hyperparams.ctrnnMinTau != null ? Hyperparams.ctrnnMinTau : 1.0;

        // Stage 1: copy inputs.
        for (let i = 0; i < c.n_inputs; i++) {
            acts[i] = obs_buffer[i] || 0;
        }
        // Stage 2: hiddens — CTRNN leaky-integrator update, then tanh(y + θ).
        for (let h = 0; h < c.n_hiddens; h++) {
            let sum = 0;
            const incoming = c.incoming_hidden[h];
            for (let k = 0; k < incoming.length; k++) {
                sum += incoming[k].weight * acts[incoming[k].src_index];
            }
            if (ctrnnOn) {
                const tau = Math.max(c.hidden_taus[h], minTau);
                const alpha = Math.min(1.0, dt / tau);
                const new_y = (1 - alpha) * state[h] + alpha * sum;
                state[h] = new_y;
                acts[c.hidden_offset + h] = Math.tanh(new_y + c.hidden_biases[h]);
            } else {
                // Pure feedforward — bias folds into the pre-tanh sum so the
                // numerical result matches the Phase-3 path bit-for-bit.
                acts[c.hidden_offset + h] = Math.tanh(sum + c.hidden_biases[h]);
            }
        }
        // Stage 3: outputs (stateless: tanh of weighted sum from inputs + hiddens).
        for (let o = 0; o < c.n_outputs; o++) {
            let sum = 0;
            const incoming = c.incoming_output[o];
            for (let k = 0; k < incoming.length; k++) {
                sum += incoming[k].weight * acts[incoming[k].src_index];
            }
            acts[c.output_offset + o] = Math.tanh(sum);
        }
        return acts.subarray(c.output_offset, c.output_offset + c.n_outputs);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Counts (used by FossilRecord for network-size telemetry).
    // ─────────────────────────────────────────────────────────────────────

    numEnabledConnections() {
        let n = 0;
        for (const c of this.connections) if (c.enabled) n++;
        return n;
    }

    numHiddenNodes() {
        return this.hiddens.length;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Save / load.
    // ─────────────────────────────────────────────────────────────────────

    serialize() {
        return {
            type:        "neat-v1",
            inputs:      this.inputs.slice(),
            outputs:     this.outputs.slice(),
            hiddens:     this.hiddens.map(h => ({ id: h.id, tau: h.tau, bias: h.bias })),
            connections: this.connections.map(c => ({
                innovation_id: c.innovation_id,
                src:           c.src,
                dst:           c.dst,
                weight:        c.weight,
                enabled:       c.enabled,
            })),
        };
    }

    loadFromSerialized(raw) {
        this.inputs  = (raw.inputs  || []).slice();
        this.outputs = (raw.outputs || []).slice();
        this.hiddens = (raw.hiddens || []).map(h => ({
            id: h.id, tau: h.tau != null ? h.tau : 1.0, bias: h.bias != null ? h.bias : 0.0,
        }));
        this.connections = (raw.connections || []).map(c => ({
            innovation_id: c.innovation_id,
            src: c.src, dst: c.dst,
            weight:  clampWeight(c.weight || 0),
            enabled: c.enabled !== false,
        }));
        this._resyncHiddenState();   // sized to new hidden count, zeroed
        this._compiled = null;
    }

    /** Deep-copy this genome. Shared with NNBrain.copy(). */
    cloneInto(other) {
        other.inputs  = this.inputs.slice();
        other.outputs = this.outputs.slice();
        other.hiddens = this.hiddens.map(h => ({ id: h.id, tau: h.tau, bias: h.bias }));
        other.connections = this.connections.map(c => ({
            innovation_id: c.innovation_id,
            src: c.src, dst: c.dst,
            weight: c.weight, enabled: c.enabled,
        }));
        // Offspring start with FRESH membrane state — no inherited "thoughts".
        other._hidden_state = new Float32Array(this.hiddens.length);
        other._compiled = null;
    }
}

module.exports = Genome;
