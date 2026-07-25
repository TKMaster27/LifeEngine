const CellStates = require("../CellStates");
const BodyCell = require("./BodyCell");
const Hyperparams = require("../../../Hyperparameters");

class MouthCell extends BodyCell{
    constructor(org, loc_col, loc_row, food=0){
        
        super(CellStates.mouth, org, loc_col, loc_row);
        this.diet = food;
    }

    performFunction() {
        var env = this.org.env;
        var real_c = this.getRealCol();
        var real_r = this.getRealRow();
        for (var loc of Hyperparams.edibleNeighbors){
            var cell = env.grid_map.cellAt(real_c+loc[0], real_r+loc[1]);
            this.eatNeighbor(cell, env);
        }
    }

    eatNeighbor(n_cell, env) {
        if (n_cell == null)
            return;
        if (n_cell.state == CellStates.food){
            
            const baseNutrition = (typeof n_cell.nutrition === "number") ? n_cell.nutrition : 1.0;
            
            // const inDiet = this.org.getEdibleFoodTypes().includes(n_cell.foodType);
            // const efficiency = inDiet ? this.org.foodAbsorptionMultiplier() : 0.05;
            
            
            // Get the diet array ONCE
            const edibleTypes = this.org.getEdibleFoodTypes();
            const inDiet = edibleTypes.includes(n_cell.foodType);

            let efficiency = 0.05; // off-diet food is nearly indigestible
            if (inDiet) {
                // Diet-breadth penalty applies to ALL diet types INCLUDING meat
                // (type 0): eating meat + plant is a broader, more complex diet
                // (a compromise "gut"), so it lowers per-bite efficiency like any
                // other extra food type. Tunable a / n^p.
                const n = edibleTypes.length;
                efficiency = n > 1
                    ? Hyperparams.dietPenaltyStrength / Math.pow(n, Hyperparams.dietPenaltyExponent)
                    : 1.0;
            }



            this.org.food_collected += baseNutrition * efficiency;
            env.changeCell(n_cell.col, n_cell.row, CellStates.empty, null);
        }
    }

    initDefault(){
        this.diet = 0;
    }

    initRandom(){
        // Conservative diet: bias a new mouth toward the organism's existing
        // diet (see Organism.mutatedMouthDiet) so specialists don't drift into
        // generalists every time a mouth is grown. Falls back to uniform random
        // when the organism/anatomy isn't available yet.
        this.diet = (this.org && typeof this.org.mutatedMouthDiet === "function")
            ? this.org.mutatedMouthDiet()
            : Hyperparams.getRandomFoodTypeId();
    }

    initInherit(parent) {
        super.initInherit(parent);
        this.diet = parent.diet;

        // ensures producers cannot eat food types zero (meat)
        // while (this.org.anatomy.is_producer && this.diet === 0) {
        //      this.diet = Hyperparams.getRandomFoodTypeId();
        // }
    }
}

module.exports = MouthCell;