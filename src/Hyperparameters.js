const Neighbors = require("./Grid/Neighbors");

const Hyperparams = {
    setDefaults: function() {
        this.lifespanMultiplier = 500;
        this.foodProdProb = 3;
        this.emitterProdProb = 5;
        // Emitter generation controls (used by EnvironmentController.randomizeEmitters)
        this.emitterNoiseThreshold = 0.3; // default Perlin threshold for emitter placement
        this.emitterResolution = 50; // Perlin resolution for emitter placement
        this.emitterIslandSize = 0.1; // scale for secondary noise that defines island sizes
        this.killableNeighbors = Neighbors.adjacent;
        this.edibleNeighbors = Neighbors.adjacent;
        this.growableNeighbors = Neighbors.adjacent;

        this.useGlobalMutability = false;
        this.globalMutability = 5;
        this.addProb = 5;
        this.changeProb = 5;
        this.removeProb = 5;
        this.brainMutationChance = 25;
        this.mutationSymmetryChance = 10;

        this.foodBlocksReproduction = true;
        this.moversCanProduce = false;

        this.instaKill = false;
        this.dontKillSameSpecies = false;

        this.lookRange = 300;
        this.seeThroughSelf = false;

        this.thrustDamping = 0.05;
        this.rotationalDamping = 0.1;
        this.nnMutationStrength = 0.1;
        this.nnHiddenSize = 6;   // legacy Phase-1 fixed-topology size; unused by NEAT
        // ── NEAT structural-mutation probabilities (percent per mutate() call) ──
        // These apply ONLY to "direct"-encoding brains (Phase 2 and earlier
        // saves). Phase-3 organisms use the CPPN mutation probabilities below.
        this.neatAddConnectionProb     = 5;
        this.neatAddNodeProb           = 3;
        this.neatDisableConnectionProb = 2;
        // ── HyperNEAT / CPPN structural-mutation probabilities ──────────────
        this.cppnAddConnectionProb     = 5;
        this.cppnAddNodeProb           = 3;
        this.cppnMutateActivationProb  = 4;
        this.cppnDisableConnectionProb = 1;
        // Strength of the diet-aware seeding prior added on top of CPPN-
        // generated substrate weights. 1.0 reproduces the Phase-2 prior
        // magnitudes (food-in-diet = +1.0, killer = -1.0, empty = +0.35).
        // Lower this if you want the CPPN to dominate behavior earlier;
        // 0 disables seeding entirely.
        this.cppnSeedPriorStrength     = 1.0;
        // ── CTRNN dynamics (Phase 4) ───────────────────────────────────────
        // When enabled, each substrate hidden node carries membrane-potential
        // state across ticks giving the network "thought momentum". τ = 1
        // collapses to feedforward; τ > 1 introduces a leaky integrator.
        // Hyperparams:
        // ctrnnEnabled (true): master switch. If false, the integrator is skipped and forward() is feedforward, regardless of τ.
        // ctrnnDt (1.0): integration step in simulation ticks. Lower values = finer dynamics but slower convergence per real-world tick.
        // ctrnnDefaultTau (2.0): τ assigned to fresh hidden grid nodes (HyperNEAT) and to new hiddens created by direct-mode add_node.
        // ctrnnMinTau (1.0): floor so α never exceeds 1 (numerically stable).
        this.ctrnnEnabled              = true;
        this.ctrnnDt                   = 1.0;   // one simulation tick per integration step
        this.ctrnnDefaultTau           = 3.0;   // direct-mode default (when no CPPN τ)
        this.ctrnnMinTau               = 1.0;   // clamp so α never exceeds 1 (numerically stable)
        this.ctrnnMaxTau               = 8.0;   // CPPN-output τ is mapped to [minTau, maxTau]

        this.foodDropProb = 0;
        this.altFoodTypeChance = 0.0;
        this.foodTypes = [
            { id: 0, nutrition: 1.0},
            { id: 1, nutrition: 1.0},
            { id: 2, nutrition: 1.0},
            { id: 3, nutrition: 1.0}
        ];

        this.extraMoverFoodCost = 0;

        this.deadTurnToFood = false;

        this.maxOrganisms = -1;
    },

    getFoodTypeById(id) {
        return this.foodTypes.find(t => t.id === id) || this.foodTypes[0];
    },

    getFoodNutrition(id) {
        const t = this.getFoodTypeById(id);
        return t ? t.nutrition : 1.0;
    },

    getRandomFoodTypeId() {
        const randomIndex = Math.floor(Math.random() * this.foodTypes.length);
        return this.foodTypes[randomIndex].id;
    },

    loadJsonObj(obj) {
        for (let key in obj) {
            this[key] = obj[key];
        }
    }
}

Hyperparams.setDefaults();

module.exports = Hyperparams;