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
            env.changeCell(n_cell.col, n_cell.row, CellStates.empty, null);
            this.org.food_collected++;
        }
    }

    initDefault(){
        this.diet = 0;
    }

    initRandom(){
        this.diet = Math.random() < 0.5 ? 0 : 1;
    }

    initInherit(parent) {
        super.initInherit(parent);
        this.diet = parent.diet;
        if (Math.random() < 0.01) {
            this.diet = this.diet === 0 ? 1 : 0;
        }
    }
}

module.exports = MouthCell;