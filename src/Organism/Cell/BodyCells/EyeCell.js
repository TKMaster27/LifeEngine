const CellStates = require("../CellStates");
const BodyCell = require("./BodyCell");
const Hyperparams = require("../../../Hyperparameters");
const Directions = require("../../Directions");
// const Observation = require("../../Perception/Observation")

class EyeCell extends BodyCell{
    constructor(org, loc_col, loc_row){
        super(CellStates.eye, org, loc_col, loc_row);
        this.org.anatomy.has_eyes = true;
    }

    initInherit(parent) {
        super.initInherit(parent);
        this.direction = (parent.direction !== undefined) ? parent.direction : Directions.up;
    }
    
    initRandom() {
        // initialize values randomly
        this.direction = Directions.getRandomDirection();
    }

    initDefault() {
        // initialize to default values
        this.direction = Directions.up;
    }

    getAbsoluteDirection() {
        var dir = this.org.rotation + this.direction;
        if (dir > 3)
            dir -= 4;
        return dir;
    }

    performFunction() {
        this.look();
    }

    look() {
        var env = this.org.env;
        var direction = this.getAbsoluteDirection();
        var addCol = 0;
        var addRow = 0;
        
        switch(direction) {
            case Directions.up: addRow = -1; break;
            case Directions.down: addRow = 1; break;
            case Directions.right: addCol = 1; break;
            case Directions.left: addCol = -1; break;
        }
        
        var start_col = this.getRealCol();
        var start_row = this.getRealRow();
        var col = start_col;
        var row = start_row;
        var cell = null;

        var map = env.grid_map;
        var grid = map.grid;
        var maxCol = map.cols;
        var maxRow = map.rows;

        let my_eye_index = 0;
        for (let c of this.org.anatomy.cells) {
            if (c.state.name === CellStates.eye.name) {
                if (c === this) break;
                my_eye_index++;
            }
        }

        for (var i=0; i<Hyperparams.lookRange; i++){
            col += addCol;
            row += addRow;

            if (col < 0 || col >= maxCol || row < 0 || row >= maxRow) {
                break;
            }

            cell = grid[col][row];

            if (cell.owner === this.org && Hyperparams.seeThroughSelf) {
                continue;
            }

            if (cell.state !== CellStates.empty) {
                var distance = Math.abs(start_col-col) + Math.abs(start_row-row);
                this.org.brain.observe(cell, distance, direction, my_eye_index, col - start_col, row - start_row);
                return;
            }
        }

        this.org.brain.observe(cell, Hyperparams.lookRange, direction, my_eye_index, 0, 0);
    }
}

module.exports = EyeCell;