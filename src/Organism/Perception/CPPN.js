// Compositional Pattern-Producing Network (HyperNEAT Phase 3).
//
// A small NEAT-evolved feedforward network whose job is to GENERATE the
// weights of the substrate network (the one that drives the organism). The
// CPPN is queried once per (src, dst) substrate node pair, takes geometric
// coordinates as input, and returns (weight, leo). The LEO output gates
// whether each substrate connection actually exists, giving the CPPN
// fine-grained control over substrate sparsity.
//
// Unlike the substrate genome (Genome.js), the CPPN has NO depth limit and
// allows mixed activation functions on its hidden nodes — these together
// produce the symmetric, repeating, gradient-like weight patterns over
// substrate geometry that make HyperNEAT effective.
//
// CPPN inputs (8):
//     src_x, src_y, src_z   — source substrate node coords (normalised)
//     dst_x, dst_y, dst_z   — destination node coords
//     distance              — euclidean distance in 3-space, normalised
//     bias                  — constant 1.0
//
// CPPN outputs (3):
//     weight                — substrate connection weight (tanh-bounded ∈ [-1, 1])
//     leo                   — link-expression gate (substrate edge exists iff leo > 0.5)
//     tau                   — per-node CTRNN time constant (sigmoid ∈ (0, 1),
//                             mapped to [ctrnnMinTau, ctrnnMaxTau] at the
//                             substrate-build step). Only meaningful when the
//                             query coords are a hidden's self-position; for
//                             non-self queries the value is ignored.
//
// Node IDs are strings:
//     "in:src_x" / "in:src_y" / ...           — input ids (constant set)
//     "out:weight" / "out:leo" / "out:tau"    — output ids (constant set)
//     "ch:<n>"                                — cppn hidden ids, minted by Innovation

const Innovation = require("./Innovation");

const INPUT_IDS  = ["in:src_x", "in:src_y", "in:src_z",
                    "in:dst_x", "in:dst_y", "in:dst_z",
                    "in:distance", "in:bias"];
const OUTPUT_IDS = ["out:weight", "out:leo", "out:tau"];
const N_INPUTS   = INPUT_IDS.length;   // 8
const N_OUTPUTS  = OUTPUT_IDS.length;  // 3

const ACTIVATIONS = {
    sigmoid:  (x) => 1 / (1 + Math.exp(-x)),
    gauss:    (x) => Math.exp(-x * x),
    sin:      (x) => Math.sin(x),
    identity: (x) => x,
    abs:      (x) => Math.abs(x),
    tanh:     (x) => Math.tanh(x),
};
const ACTIVATION_NAMES = Object.keys(ACTIVATIONS);

function gaussRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

const WEIGHT_CLAMP = 4.0;  // CPPN-internal clamp; substrate weight is then tanh-bounded.
function clampWeight(w) {
    if (w >  WEIGHT_CLAMP) return  WEIGHT_CLAMP;
    if (w < -WEIGHT_CLAMP) return -WEIGHT_CLAMP;
    return w;
}

function pickRandomActivation() {
    return ACTIVATION_NAMES[(Math.random() * ACTIVATION_NAMES.length) | 0];
}

class CPPN {
    constructor() {
        // Fixed input/output sets; only hidden topology evolves.
        this.inputs  = INPUT_IDS.slice();
        this.outputs = OUTPUT_IDS.slice();
        this.hiddens = [];                  // [{ id, activation }]
        // Per-output activation. `weight` uses tanh (substrate weight ∈ [-1, 1]
        // before scaling), `leo` and `tau` use sigmoid so their (0, 1) range is
        // easy to interpret as gate/normalised-τ.
        this.output_activations = {
            "out:weight": "tanh",
            "out:leo":    "sigmoid",
            "out:tau":    "sigmoid",
        };

        this.connections = [];               // [{ innovation_id, src, dst, weight, enabled }]

        // Compiled-form cache, rebuilt on structural change.
        this._compiled = null;

        this._initMinimal();
    }

    /** Minimal initial topology: each input directly connected to each output
     *  with small gaussian weights. No hidden nodes; structure emerges via
     *  add_node / add_connection mutations.
     *
     *  Seeding contract:
     *   - (in:bias → out:leo) starts at +3.0 so sigmoid(LEO) ≈ 0.95 across
     *     all queries — the LEO gate stays open for a fresh organism so the
     *     diet-aware seeding prior added by NNBrain isn't silently pruned.
     *   - Every connection feeding `out:weight` starts with TINY gaussian
     *     noise (≈ ±0.02). With near-zero CPPN-weight output, fresh substrate
     *     connections take their value almost entirely from the prior, so the
     *     organism behaves like Phase-2 direct-mode at tick 0. Subsequent
     *     mutations grow these weights and the CPPN takes over.
     *   - LEO feeders other than bias get small noise too — bias dominates
     *     so the gate opens uniformly until mutations differentiate. */
    _initMinimal() {
        for (const inp of INPUT_IDS) {
            for (const out of OUTPUT_IDS) {
                let weight;
                if (inp === "in:bias" && out === "out:leo") {
                    weight = 3.0;
                } else if (out === "out:leo") {
                    weight = gaussRandom() * 0.1;
                } else if (inp === "in:bias" && out === "out:tau") {
                    // sigmoid(-0.5) ≈ 0.378 — with the default tau range
                    // [minTau=1, maxTau=8] this maps to τ ≈ 3.6, matching the
                    // pre-CPPN-τ default (3.0). Mutations move it from there.
                    weight = -0.5;
                } else if (out === "out:tau") {
                    weight = gaussRandom() * 0.1;
                } else {
                    // Near-zero start for out:weight feeders — see comment above.
                    weight = gaussRandom() * 0.02;
                }
                this.connections.push({
                    innovation_id: Innovation.getConnectionId(inp, out),
                    src: inp, dst: out,
                    weight: clampWeight(weight),
                    enabled: true,
                });
            }
        }
        this._compiled = null;
    }

    // ─── Topological-sort compilation ────────────────────────────────────

    _nodeType(id) {
        if (id.startsWith("in:"))  return "input";
        if (id.startsWith("out:")) return "output";
        if (id.startsWith("ch:"))  return "hidden";
        return null;
    }

    /** Topologically sort all nodes using Kahn's algorithm.
     *
     *  Seeds the queue with EVERY node whose initial in-degree is zero, not
     *  just inputs. This matters because a `disable_connection` mutation can
     *  leave a hidden node with no enabled incoming edges — that hidden is
     *  orphaned (constant output of activation_fn(0)) but it still belongs
     *  in the order. If we only seeded with inputs it would be silently
     *  dropped, `order.length < all_nodes.length`, and the whole CPPN would
     *  be flagged as cyclic. Returns null on a genuine cycle (which
     *  add_connection's forward-only rule prevents in practice). */
    _topoOrder() {
        const all_nodes = [
            ...this.inputs,
            ...this.hiddens.map(h => h.id),
            ...this.outputs,
        ];
        const in_degree = new Map(all_nodes.map(id => [id, 0]));
        const out_adj   = new Map(all_nodes.map(id => [id, []]));
        for (const c of this.connections) {
            if (!c.enabled) continue;
            if (!in_degree.has(c.src) || !in_degree.has(c.dst)) continue;
            out_adj.get(c.src).push(c.dst);
            in_degree.set(c.dst, in_degree.get(c.dst) + 1);
        }
        // Inputs first (so the input-activation indices stay deterministic),
        // then any orphaned hiddens with in_degree=0.
        const queue = [];
        for (const id of this.inputs) queue.push(id);
        for (const h of this.hiddens) {
            if (in_degree.get(h.id) === 0) queue.push(h.id);
        }
        for (const id of this.outputs) {
            if (in_degree.get(id) === 0) queue.push(id);
        }
        const order = [];
        while (queue.length > 0) {
            const id = queue.shift();
            order.push(id);
            for (const dst of out_adj.get(id) || []) {
                const nd = in_degree.get(dst) - 1;
                in_degree.set(dst, nd);
                if (nd === 0) queue.push(dst);
            }
        }
        return order.length === all_nodes.length ? order : null;
    }

    _recompile() {
        const order = this._topoOrder();
        if (order === null) {
            // Genuine cycle — leave the CPPN in a safely degenerate state.
            // query() short-circuits to weight=0/leo=0, so the substrate
            // sees no CPPN-derived connections this build; the diet-aware
            // prior in NNBrain still applies and the organism keeps a sane
            // baseline until the next mutation breaks the cycle.
            this._compiled = { _degenerate: true };
            return;
        }
        const node_idx        = new Map(order.map((id, i) => [id, i]));
        const incoming        = new Map(order.map(id => [id, []]));
        for (const c of this.connections) {
            if (!c.enabled) continue;
            if (!incoming.has(c.dst) || !node_idx.has(c.src)) continue;
            incoming.get(c.dst).push({ src_index: node_idx.get(c.src), weight: c.weight });
        }
        const node_activation = new Map();
        for (const id of this.inputs)  node_activation.set(id, "identity");
        for (const h  of this.hiddens) node_activation.set(h.id, h.activation);
        for (const id of this.outputs) node_activation.set(id, this.output_activations[id] || "tanh");

        this._compiled = {
            topo:            order,
            node_idx,
            incoming,
            node_activation,
            n_total:         order.length,
        };
    }

    /** Forward pass for one substrate query. Returns { weight, leo, expressed }
     *  where `expressed` is true iff the LEO gate fires (leo > 0.5). */
    query(src_x, src_y, src_z, dst_x, dst_y, dst_z, distance) {
        if (this._compiled === null) this._recompile();
        const c = this._compiled;
        if (c._degenerate) {
            // 0.5 is the sigmoid midpoint → τ at midpoint of the configured
            // range; weight=0 → no signal; leo=0 → gate closed.
            return { weight: 0, leo: 0, tau: 0.5, expressed: false };
        }
        const acts = new Float64Array(c.n_total);

        const idx = c.node_idx;
        acts[idx.get("in:src_x")]    = src_x;
        acts[idx.get("in:src_y")]    = src_y;
        acts[idx.get("in:src_z")]    = src_z;
        acts[idx.get("in:dst_x")]    = dst_x;
        acts[idx.get("in:dst_y")]    = dst_y;
        acts[idx.get("in:dst_z")]    = dst_z;
        acts[idx.get("in:distance")] = distance;
        acts[idx.get("in:bias")]     = 1.0;

        // Propagate through the topo order. Orphaned hidden nodes (whose
        // sole incoming connection was disabled) have an empty `inc` list,
        // so their pre-activation sum is 0 and they emit activation_fn(0)
        // as a constant.
        for (let i = 0; i < c.topo.length; i++) {
            const node = c.topo[i];
            if (node.startsWith("in:")) continue;
            const inc = c.incoming.get(node);
            let sum = 0;
            if (inc) {
                for (let k = 0; k < inc.length; k++) {
                    sum += inc[k].weight * acts[inc[k].src_index];
                }
            }
            const fn = ACTIVATIONS[c.node_activation.get(node) || "tanh"];
            acts[i] = fn(sum);
        }

        const weight = acts[idx.get("out:weight")];
        const leo    = acts[idx.get("out:leo")];     // sigmoid output ∈ (0, 1)
        const tau    = acts[idx.get("out:tau")];     // sigmoid output ∈ (0, 1)
        return { weight, leo, tau, expressed: leo > 0.5 };
    }

    // ─── Mutations ───────────────────────────────────────────────────────

    perturbWeights(strength) {
        for (const c of this.connections) {
            if (!c.enabled) continue;
            c.weight = clampWeight(c.weight + gaussRandom() * strength);
        }
        this._compiled = null;
    }

    /** Try to add a new connection between two random nodes. Forward-edge
     *  only: src must appear before dst in the current topo order. Returns
     *  the new connection on success, null on failure. */
    addRandomConnection() {
        if (this._compiled === null) this._recompile();
        const order = this._compiled.topo;
        if (!order || order.length < 2) return null;
        for (let attempt = 0; attempt < 16; attempt++) {
            const si = (Math.random() * (order.length - 1)) | 0;
            const di = si + 1 + ((Math.random() * (order.length - si - 1)) | 0);
            const src = order[si], dst = order[di];
            if (src.startsWith("out:")) continue;
            if (dst.startsWith("in:"))  continue;
            if (src === dst) continue;
            if (this.connections.some(c => c.src === src && c.dst === dst)) continue;
            const conn = {
                innovation_id: Innovation.getConnectionId(src, dst),
                src, dst,
                weight: clampWeight(gaussRandom() * 0.5),
                enabled: true,
            };
            this.connections.push(conn);
            this._compiled = null;
            return conn;
        }
        return null;
    }

    /** Split a random enabled connection by inserting a new hidden node. The
     *  new hidden picks a random activation from the standard set. */
    addRandomNode() {
        const enabled = this.connections.filter(c => c.enabled);
        if (enabled.length === 0) return null;
        const old = enabled[(Math.random() * enabled.length) | 0];
        old.enabled = false;
        const hidden_id = "ch:" + Innovation.nextHiddenId().split(":")[1];
        const new_hidden = { id: hidden_id, activation: pickRandomActivation() };
        this.hiddens.push(new_hidden);
        const in_conn = {
            innovation_id: Innovation.getConnectionId(old.src, hidden_id),
            src: old.src, dst: hidden_id, weight: 1.0, enabled: true,
        };
        const out_conn = {
            innovation_id: Innovation.getConnectionId(hidden_id, old.dst),
            src: hidden_id, dst: old.dst, weight: clampWeight(old.weight), enabled: true,
        };
        this.connections.push(in_conn, out_conn);
        this._compiled = null;
        return new_hidden;
    }

    mutateRandomActivation() {
        if (this.hiddens.length === 0) return null;
        const h = this.hiddens[(Math.random() * this.hiddens.length) | 0];
        const old = h.activation;
        let next = old;
        // Pick a *different* activation so a mutation always changes something.
        for (let attempt = 0; attempt < 8 && next === old; attempt++) {
            next = pickRandomActivation();
        }
        h.activation = next;
        this._compiled = null;
        return h;
    }

    disableRandomConnection() {
        const enabled = this.connections.filter(c => c.enabled);
        if (enabled.length === 0) return null;
        const pick = enabled[(Math.random() * enabled.length) | 0];
        pick.enabled = false;
        this._compiled = null;
        return pick;
    }

    // ─── Telemetry / save-load ───────────────────────────────────────────

    numEnabledConnections() {
        let n = 0; for (const c of this.connections) if (c.enabled) n++; return n;
    }
    numHiddenNodes() { return this.hiddens.length; }

    serialize() {
        return {
            type: "cppn-v1",
            output_activations: { ...this.output_activations },
            hiddens: this.hiddens.map(h => ({ id: h.id, activation: h.activation })),
            connections: this.connections.map(c => ({
                innovation_id: c.innovation_id,
                src: c.src, dst: c.dst,
                weight: c.weight, enabled: c.enabled,
            })),
        };
    }

    loadFromSerialized(raw) {
        if (!raw || raw.type !== "cppn-v1") return false;
        this.hiddens = (raw.hiddens || []).map(h => ({
            id: h.id, activation: h.activation || "tanh",
        }));
        if (raw.output_activations) {
            this.output_activations = { ...this.output_activations, ...raw.output_activations };
        }
        this.connections = (raw.connections || []).map(c => ({
            innovation_id: c.innovation_id,
            src: c.src, dst: c.dst,
            weight: clampWeight(c.weight || 0),
            enabled: c.enabled !== false,
        }));
        this._compiled = null;
        return true;
    }

    cloneInto(other) {
        other.hiddens = this.hiddens.map(h => ({ id: h.id, activation: h.activation }));
        other.output_activations = { ...this.output_activations };
        other.connections = this.connections.map(c => ({
            innovation_id: c.innovation_id,
            src: c.src, dst: c.dst,
            weight: c.weight, enabled: c.enabled,
        }));
        other._compiled = null;
    }
}

CPPN.INPUT_IDS  = INPUT_IDS;
CPPN.OUTPUT_IDS = OUTPUT_IDS;
CPPN.ACTIVATION_NAMES = ACTIVATION_NAMES;

module.exports = CPPN;
