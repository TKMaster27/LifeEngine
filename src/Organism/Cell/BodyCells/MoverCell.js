const CellStates = require("../CellStates");
const BodyCell = require("./BodyCell");
const Directions = require("../../Directions");

class MoverCell extends BodyCell {
    constructor(org, loc_col, loc_row) {
        super(CellStates.mover, org, loc_col, loc_row);
        this.org.anatomy.is_mover = true;
    }

    initInherit(parent) {
        super.initInherit(parent);
        // fall back to up if inheriting from an old save that predates the direction field
        this.direction = (parent.direction !== undefined) ? parent.direction : Directions.up;
    }

    initRandom() {
        this.direction = Directions.getRandomDirection();
    }

    initDefault() {
        this.direction = Directions.up;
    }

    getAbsoluteDirection() {
        var dir = this.org.rotation + this.direction;
        if (dir > 3)
            dir -= 4;
        return dir;
    }
}

module.exports = MoverCell;
