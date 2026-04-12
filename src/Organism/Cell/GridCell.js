const CellStates = require("./CellStates");

// A cell exists in a grid map.
class Cell{
    constructor(state, col, row, x, y){
        this.foodType = -1; // foodType of -1 is a non-food cell
        this.nutrition = 0.0;
        this.owner = null; // owner organism
        this.cell_owner = null; // specific body cell of the owner organism that occupies this grid cell
        this.setType(state);
        this.col = col;
        this.row = row;
        this.x = x;
        this.y = y;
    }

    setType(state) {
        this.state = state;
        if(state !== CellStates.food) {
            this.foodType = -1;
            this.nutrition = 0.0;
        }
    }

    setFood(typeID, nutrition) {
        this.state = CellStates.food;
        this.foodType = typeID;
        this.nutrition = nutrition;
    }
}

module.exports = Cell;
