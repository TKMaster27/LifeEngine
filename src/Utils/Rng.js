'use strict';

// mulberry32 — small, fast, well-tested seedable PRNG.
// Period 2^32; fine for reproducibility, not for cryptography.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const Rng = {
    seed: null,
    _rand: Math.random.bind(Math),
    _installed: false,

    setSeed(seed) {
        this.seed = seed >>> 0;
        this._rand = mulberry32(this.seed);
    },

    random() {
        return this._rand();
    },

    // Override the global Math.random so every existing call site becomes
    // deterministic without source-level changes. Call once, after setSeed().
    install() {
        if (this._installed) return;
        const self = this;
        Math.random = function() { return self._rand(); };
        this._installed = true;
    },
};

module.exports = Rng;
