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
        if (n_cell.state == CellStates.food && n_cell.foodType == this.diet){
            
            const baseNutrition = (typeof n_cell.nutrition === "number") ? n_cell.nutrition : 1.0;
            const efficiency = this.org.foodAbsorptionMultiplier();


            this.org.food_collected += baseNutrition * efficiency;
            env.changeCell(n_cell.col, n_cell.row, CellStates.empty, null);
        }
    }

    initDefault(){
        this.diet = 0;
    }

    initRandom(){
        this.diet = Hyperparams.getRandomFoodTypeId();
    }

    initInherit(parent) {
        super.initInherit(parent);
        this.diet = parent.diet;
        if (Math.random() < 0.001) {
            this.diet = Hyperparams.getRandomFoodTypeId();
        }

        // ensures producers cannot eat food types zero (meat)
        while (this.org.anatomy.is_producer && this.diet === 0) {
             this.diet = Hyperparams.getRandomFoodTypeId();
        }
    }
}

module.exports = MouthCell;