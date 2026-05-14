// Brain interface — all brain implementations must provide these methods.
class Brain {
    constructor() {}
    observe(cell, distance, direction, eye_index, dx, dy) { throw new Error('not implemented'); }
    decide() { throw new Error('not implemented'); }
    mutate() { throw new Error('not implemented'); }
    copy(other) { throw new Error('not implemented'); }
    serialize() { throw new Error('not implemented'); }
    loadRaw(raw) { throw new Error('not implemented'); }
    checkAddedCell(cell) {}
    checkRemovedCell(cell) {}
}

module.exports = Brain;