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
        this.addProb = 25;
        this.changeProb = 25;
        this.removeProb = 25;
        this.brainMutationChance = 25;
        this.mutationSymmetryChance = 10;
        
        this.rotationEnabled = true;

        this.foodBlocksReproduction = true;
        this.moversCanProduce = false;

        this.instaKill = false;
        this.dontKillSameSpecies = false;

        this.lookRange = 300;
        this.seeThroughSelf = false;
        this.evolveIndependentEyeDecisions = true;

        this.thrustDamping = 0.05;
        this.rotationalDamping = 0.1;
        this.nnMutationStrength = 0.1;

        this.foodDropProb = 0;
        this.altFoodTypeChance = 0.0;
        this.foodTypes = [
            { id: 0, nutrition: 1.5},
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