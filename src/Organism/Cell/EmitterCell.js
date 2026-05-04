const CellStates = require("./CellStates");
const Hyperparams = require("../../Hyperparameters");

class EmitterCell {
    constructor(env, col, row, typeId){
        this.env = env;
        this.col = col;
        this.row = row;
        this.foodType = typeId;
    }

    update() {
        let myGridCell = this.env.grid_map.cellAt(this.col, this.row);
        if (myGridCell == null || myGridCell.state !== CellStates.emitter) {
            return; // Act dead, do nothing.
        }

        var prob = Hyperparams.emitterProdProb; // You could also add an 'emitterProdProb' in Hyperparams

        // Randomly produce food according to the probability
        if (Math.random() * 100 <= prob) {
            var loc = Hyperparams.growableNeighbors[Math.floor(Math.random() * Hyperparams.growableNeighbors.length)]
            var loc_c = loc[0];
            var loc_r = loc[1];

            var target_c = this.col + loc_c;
            var target_r = this.row + loc_r;
            
            var cell = this.env.grid_map.cellAt(target_c, target_r);
            
            // If the adjacent target cell is empty, grow food
            if (cell != null && cell.state === CellStates.empty) {

                const nutrition = Hyperparams.getFoodNutrition(this.foodType);
                
                // Add food to the environment
                this.env.changeFoodCell(target_c, target_r, this.foodType, nutrition, null);
            }
        }
    }
}

module.exports = EmitterCell;
