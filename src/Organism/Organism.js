const CellStates = require("./Cell/CellStates");
const Neighbors = require("../Grid/Neighbors");
const Hyperparams = require("../Hyperparameters");
const Directions = require("./Directions");
const Anatomy = require("./Anatomy");
const NNBrain = require("./Perception/NNBrain");
const FossilRecord = require("../Stats/FossilRecord");
const SerializeHelper = require("../Utils/SerializeHelper");

class Organism {
    constructor(col, row, env, parent=null) {
        this.c = col;
        this.r = row;
        this.env = env;
        this.lifetime = 0;
        this.food_collected = 0;
        this.living = true;
        this.anatomy = new Anatomy(this);
        this.rotation = Directions.up;
        this.mutability = 5;
        this.damage = 0;
        // continuous movement accumulators for thrust+torque locomotion
        this.vx = 0;
        this.vy = 0;
        this.omega = 0;
        this.brain = new NNBrain(this);
        if (parent != null) {
            this.inherit(parent);
        }
    }

    inherit(parent) {
        this.mutability = parent.mutability;
        this.species = parent.species;
        for (var c of parent.anatomy.cells){
            this.anatomy.addInheritCell(c);
        }
        this.brain.copy(parent.brain);
    }

    foodNeeded() {
        return this.anatomy.is_mover ? this.anatomy.cells.length + Hyperparams.extraMoverFoodCost : this.anatomy.cells.length;
    }

    lifespan() {
        return this.anatomy.cells.length * Hyperparams.lifespanMultiplier;
    }

    maxHealth() {
        return this.anatomy.cells.length;
    }

    reproduce() {
        var org = new Organism(0, 0, this.env, this);
        org.rotation = Directions.getRandomDirection();
        var prob = this.mutability;
        if (Hyperparams.useGlobalMutability){
            prob = Hyperparams.globalMutability;
        }
        else {
            if (Math.random() <= 0.5)
                org.mutability++;
            else{
                org.mutability--;
                if (org.mutability < 1)
                    org.mutability = 1;
            }
        }
        var mutated = false;
        if (this.calcRandomChance(prob)) {
            mutated = org.mutate();
        }

        var direction = Directions.getRandomScalar();
        var direction_c = direction[0];
        var direction_r = direction[1];
        var offset = (Math.floor(Math.random() * 3));
        var basemovement = this.anatomy.birth_distance;
        var new_c = this.c + (direction_c*basemovement) + (direction_c*offset);
        var new_r = this.r + (direction_r*basemovement) + (direction_r*offset);

        if (org.isClear(new_c, new_r, org.rotation, true) &&
            org.isStraightPath(new_c, new_r, this.c, this.r, this) &&
            this.env.canAddOrganism())
        {
            org.c = new_c;
            org.r = new_r;
            this.env.addOrganism(org);
            org.updateGrid();
            if (mutated) {
                FossilRecord.addSpecies(org, this.species);
            }
            else {
                org.species.addPop();
            }
        }
        Math.max(this.food_collected -= this.foodNeeded(), 0);
    }

    mutate() {
        let added = false;
        let changed = false;
        let removed = false;
        if (this.calcRandomChance(Hyperparams.addProb)) {
            let branch = this.anatomy.getRandomCell();
            let state = CellStates.getRandomLivingType();
            let growth_direction = Neighbors.all[Math.floor(Math.random() * Neighbors.all.length)];
            let c = branch.loc_col + growth_direction[0];
            let r = branch.loc_row + growth_direction[1];
            if (this.anatomy.canAddCellAt(c, r)) {
                added = true;
                this.anatomy.addRandomizedCell(state, c, r);

                const axes = ['h', 'v', 'd'];
                for (let axis of axes) {
                    if (this.calcRandomChance(Hyperparams.mutationSymmetryChance)) {
                        let mc = c;
                        let mr = r;
                        switch (axis) {
                            case 'h':
                                mr = -r;
                                if (r === 0) { mr = c; mc = -r; }
                                break;
                            case 'v':
                                mc = -c;
                                if (c === 0) { mr = -c; mc = r; }
                                break;
                            case 'd':
                                mc = -c;
                                mr = -r;
                                break;
                        }
                        if (this.anatomy.canAddCellAt(mc, mr)) {
                            this.anatomy.addRandomizedCell(state, mc, mr);
                        }
                    }
                }
            }
        }
        if (this.calcRandomChance(Hyperparams.changeProb)){
            let cell = this.anatomy.getRandomCell();
            if (cell.state === CellStates.mouth && this.calcRandomChance(50)) {
                cell.diet = Hyperparams.getRandomFoodTypeId();
                changed = true;
            } else {
                let state = CellStates.getRandomLivingType();
                this.anatomy.replaceCell(state, cell.loc_col, cell.loc_row);
                changed = true;
            }
        }
        if (this.calcRandomChance(Hyperparams.removeProb)){
            if(this.anatomy.cells.length > 1) {
                let cell = this.anatomy.getRandomCell();
                removed = this.anatomy.removeCell(cell.loc_col, cell.loc_row);
            }
        }
        if (this.anatomy.is_mover && this.calcRandomChance(Hyperparams.brainMutationChance)) {
            if (this.anatomy.has_eyes) {
                this.brain.mutate();
            }
        }
        return added || changed || removed;
    }

    calcRandomChance(prob) {
        return (Math.random() * 100) < prob;
    }

    attemptMove(dc, dr) {
        var new_c = this.c + dc;
        var new_r = this.r + dr;
        if (this.isClear(new_c, new_r)) {
            for (var cell of this.anatomy.cells) {
                var real_c = this.c + cell.rotatedCol(this.rotation);
                var real_r = this.r + cell.rotatedRow(this.rotation);
                this.env.changeCell(real_c, real_r, CellStates.empty, null);
            }
            this.c = new_c;
            this.r = new_r;
            this.updateGrid();
            return true;
        }
        return false;
    }

    attemptRotate(rotation=null) {
        if(rotation == null){
            rotation = Directions.getRandomDirection();
        }
        if(this.isClear(this.c, this.r, rotation)){
            for (var cell of this.anatomy.cells) {
                var real_c = this.c + cell.rotatedCol(this.rotation);
                var real_r = this.r + cell.rotatedRow(this.rotation);
                this.env.changeCell(real_c, real_r, CellStates.empty, null);
            }
            this.rotation = rotation;
            this.updateGrid();
            return true;
        }
        return false;
    }

    isStraightPath(c1, r1, c2, r2, parent){
        if (c1 == c2) {
            if (r1 > r2){ var temp = r2; r2 = r1; r1 = temp; }
            for (var i=r1; i!=r2; i++) {
                var cell = this.env.grid_map.cellAt(c1, i)
                if (!this.isPassableCell(cell, parent)){ return false; }
            }
            return true;
        }
        else {
            if (c1 > c2){ var temp = c2; c2 = c1; c1 = temp; }
            for (var i=c1; i!=c2; i++) {
                var cell = this.env.grid_map.cellAt(i, r1);
                if (!this.isPassableCell(cell, parent)){ return false; }
            }
            return true;
        }
    }

    isPassableCell(cell, parent){
        return cell != null && (cell.state == CellStates.empty || cell.owner == this || cell.owner == parent || cell.state == CellStates.food);
    }

    isClear(col, row, rotation=this.rotation) {
        for(var loccell of this.anatomy.cells) {
            var cell = this.getRealCell(loccell, col, row, rotation);
            if (cell==null) { return false; }
            if (cell.owner==this || cell.state==CellStates.empty || (!Hyperparams.foodBlocksReproduction && cell.state==CellStates.food)){
                continue;
            }
            return false;
        }
        return true;
    }

    foodAbsorptionMultiplier() {
        const diets = new Set();
        for (const cell of this.anatomy.cells) {
            if (cell.state === CellStates.mouth && typeof cell.diet === "number") {
                diets.add(cell.diet);
            }
        }
        return diets.size > 1 ? 1 / Math.sqrt(diets.size) : 1.0;
    }

    getEdibleFoodTypes() {
        const diets = new Set();
        for (const cell of this.anatomy.cells) {
            if (cell.state === CellStates.mouth && typeof cell.diet === "number") {
                diets.add(cell.diet);
            }
        }
        return Array.from(diets);
    }

    harm() {
        this.damage++;
        if (this.damage >= this.maxHealth() || Hyperparams.instaKill) {
            this.die();
        }
    }

    die() {
        for (var cell of this.anatomy.cells) {
            var real_c = this.c + cell.rotatedCol(this.rotation);
            var real_r = this.r + cell.rotatedRow(this.rotation);
            if (Hyperparams.deadTurnToFood)
                this.env.changeFoodCell(real_c, real_r, 0, 1.0);
            else
                this.env.changeCell(real_c, real_r, CellStates.empty, null);
        }
        this.species.decreasePop();
        this.living = false;
    }

    updateGrid() {
        for (var cell of this.anatomy.cells) {
            var real_c = this.c + cell.rotatedCol(this.rotation);
            var real_r = this.r + cell.rotatedRow(this.rotation);
            this.env.changeCell(real_c, real_r, cell.state, cell);
        }
    }

    update() {
        this.lifetime++;
        if (this.lifetime > this.lifespan()) {
            this.die();
            return this.living;
        }
        if (this.food_collected >= this.foodNeeded()) {
            this.reproduce();
        }
        for (var cell of this.anatomy.cells) {
            cell.performFunction();
            if (!this.living)
                return this.living;
        }

        if (this.anatomy.is_mover) {
            const { thrusts } = this.brain.decide();

            let fx = 0, fy = 0, torque = 0;
            let mover_idx = 0;
            for (const m of this.anatomy.cells) {
                if (m.state !== CellStates.mover) continue;
                const thrust = (thrusts && thrusts[mover_idx] != null) ? thrusts[mover_idx] : 0;
                // Linear thrust applied in world frame.
                const [ux, uy] = Directions.scalars[m.getAbsoluteDirection()];
                fx += thrust * ux;
                fy += thrust * uy;
                // Torque computed entirely in body frame so the moment arm is
                // rotation-invariant: an asymmetric body produces the same
                // turning behaviour regardless of its current world rotation.
                const [bx, by] = Directions.scalars[m.direction];
                torque += m.loc_col * (thrust * by) - m.loc_row * (thrust * bx);
                mover_idx++;
            }

            const td = Hyperparams.thrustDamping;
            const rd = Hyperparams.rotationalDamping;
            this.vx = (this.vx + fx) * (1 - td);
            this.vy = (this.vy + fy) * (1 - td);
            this.omega = (this.omega + torque) * (1 - rd);

            if (Math.abs(this.vx) >= 1) {
                const step = Math.sign(this.vx);
                if (this.attemptMove(step, 0)) this.vx -= step;
                else this.vx = 0;
            }
            if (Math.abs(this.vy) >= 1) {
                const step = Math.sign(this.vy);
                if (this.attemptMove(0, step)) this.vy -= step;
                else this.vy = 0;
            }
            if (Math.abs(this.omega) >= Math.PI / 2) {
                const step = Math.sign(this.omega);
                const new_rot = step > 0
                    ? Directions.getRightDirection(this.rotation)
                    : Directions.getLeftDirection(this.rotation);
                if (this.attemptRotate(new_rot)) this.omega -= step * Math.PI / 2;
                else this.omega = 0;
            }
        }
        return this.living;
    }

    getRealCell(local_cell, c=this.c, r=this.r, rotation=this.rotation){
        var real_c = c + local_cell.rotatedCol(rotation);
        var real_r = r + local_cell.rotatedRow(rotation);
        return this.env.grid_map.cellAt(real_c, real_r);
    }

    isNatural() {
        let found_center = false;
        if (this.anatomy.cells.length === 0) { return false; }
        for (let i=0; i<this.anatomy.cells.length; i++) {
            let cell = this.anatomy.cells[i];
            for (let j=i+1; j<this.anatomy.cells.length; j++) {
                let toCompare = this.anatomy.cells[j];
                if (cell.loc_col === toCompare.loc_col && cell.loc_row === toCompare.loc_row) {
                    return false;
                }
            }
            if (cell.loc_col === 0 && cell.loc_row === 0) {
                found_center = true;
            }
        }
        return found_center;
    }

    serialize() {
        let org = SerializeHelper.copyNonObjects(this);
        org.anatomy = this.anatomy.serialize();
        if (this.anatomy.is_mover && this.anatomy.has_eyes)
            org.brain = this.brain.serialize();
        org.species_name = this.species.name;
        return org;
    }

    loadRaw(org) {
        SerializeHelper.overwriteNonObjects(org, this);
        this.anatomy.loadRaw(org.anatomy);
        if (org.brain) {
            this.brain.loadRaw(org.brain);
        } else if (this.brain instanceof NNBrain) {
            // anatomy.loadRaw uses addInheritCell which deliberately skips
            // brain notifications, so the substrate is still empty here.
            // Force a rebuild so anatomy and brain stay in sync.
            this.brain.buildSubstrate();
        }
    }
}

module.exports = Organism;
