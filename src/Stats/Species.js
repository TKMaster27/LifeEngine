const CellStates = require("../Organism/Cell/CellStates");
let FossilRecord = undefined; // workaround to a circular dependency problem
const getFossilRecord = () => {
    if (!FossilRecord)
        FossilRecord = require("./FossilRecord");
    return FossilRecord;
}

class Species {
    constructor(anatomy, ancestor, start_tick) {
        this.anatomy = anatomy;
        this.ancestor = ancestor; // eventually need to garbage collect ancestors to avoid memory problems
        this.population = 1;
        this.cumulative_pop = 1;
        this.start_tick = start_tick;
        this.end_tick = -1;
        this.name = Math.random().toString(36).substr(2, 10);
        this.extinct = false;
        this.calcAnatomyDetails();
    }

    calcAnatomyDetails() {
    if (!this.anatomy) return;
    var cell_counts = {};
    for (let c of CellStates.living) {
        cell_counts[c.name] = 0;
    }

    const mouth_diets = new Set();
        for (let cell of this.anatomy.cells) {
            cell_counts[cell.state.name] += 1;
            if (cell.state.name === CellStates.mouth.name && typeof cell.diet === "number") {
                mouth_diets.add(cell.diet);
            }
        }

        this.cell_counts = cell_counts;
        this.mouth_diets = Array.from(mouth_diets).sort();
    }

    addPop() {
        this.population++;
        this.cumulative_pop++;
    }

    decreasePop() {
        this.population--;
        if (this.population <= 0) {
            this.extinct = true;
            getFossilRecord().fossilize(this);
        }
    }

    lifespan() {
        return this.end_tick - this.start_tick;
    }
}

module.exports = Species;