// Global innovation tracker for NEAT structural mutations.
//
// Two responsibilities:
//   1. Hand out a unique, reproducible innovation_id for each (src, dst) node
//      pair so the same structural mutation in different organisms gets the
//      same id. Required even in our asexual setting so the fossil record can
//      attribute connections to a discrete evolutionary event.
//   2. Hand out a fresh hidden-node id every time a connection is split via
//      add_node — these are namespaced under "h:<n>" so they never clash with
//      anatomy-derived input ids ("i:<eye_index>:<feature>") or output ids
//      ("o:<mover_index>").
//
// All state is module-scoped. reset() exists for tests; the live simulation
// never calls it. The tracker is intentionally not serialised — innovation
// ids are only meaningful within a single process run.

const Innovation = {
    _next_conn_id: 0,
    _next_hidden_id: 0,
    _conn_map: new Map(),    // "src_id->dst_id" → connection innovation id

    // Returns a stable innovation id for the (src, dst) pair. The same pair
    // always yields the same id across the run. Different pairs always differ.
    getConnectionId(src_id, dst_id) {
        const key = src_id + "->" + dst_id;
        let id = this._conn_map.get(key);
        if (id === undefined) {
            id = this._next_conn_id++;
            this._conn_map.set(key, id);
        }
        return id;
    },

    // Returns a fresh hidden-node id. Called by Genome.addNode() when a
    // connection is split. Hidden ids monotonically increase and are unique
    // per run (no recycling).
    nextHiddenId() {
        return "h:" + (this._next_hidden_id++);
    },

    // Test-only: clear all tracking state. Do not call from the live sim —
    // it would re-issue ids that already point at extant organisms' genomes.
    reset() {
        this._next_conn_id = 0;
        this._next_hidden_id = 0;
        this._conn_map.clear();
    },

    // Diagnostic snapshot for the fossil record / debug overlay.
    stats() {
        return {
            connections_minted: this._next_conn_id,
            hiddens_minted:     this._next_hidden_id,
        };
    },
};

module.exports = Innovation;
