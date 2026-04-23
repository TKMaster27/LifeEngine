const Neighbors = require("./Grid/Neighbors");

const Hyperparams = {
    setDefaults: function() {
        this.lifespanMultiplier = 100;
        this.foodProdProb = 3;
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

        this.lookRange = 30;
        this.seeThroughSelf = false;
        this.evolveIndependentEyeDecisions = true;

        this.foodDropProb = 0;
        this.altFoodTypeChance = 0.0;
        this.foodTypes = [
            { id: 0, nutrition: 1.0, worldSpawnWeight: 0.5 },
            { id: 1, nutrition: 1.5, worldSpawnWeight: 0.2 }
        ];

        this.extraMoverFoodCost = 0;

        this.deadTurnToFood = true;

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
        const total = this.foodTypes.reduce((s, t) => s + (t.worldSpawnWeight || 0), 0);
        if (total <= 0) return this.foodTypes[0].id;
        let r = Math.random() * total;
        for (const t of this.foodTypes) {
            r -= (t.worldSpawnWeight || 0);
            if (r <= 0) return t.id;
        }
        return this.foodTypes[this.foodTypes.length - 1].id;
    },

    loadJsonObj(obj) {
        for (let key in obj) {
            this[key] = obj[key];
        }
    }
}

Hyperparams.setDefaults();

module.exports = Hyperparams;