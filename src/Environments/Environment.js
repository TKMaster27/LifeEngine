
//An evironment has a grid_map, controller, and renderer
class Environment{
    constructor() {
    }

    update(){
        alert("Environment.update() must be overriden");
    }

    changeCell(c, r, state, owner) {
        this.grid_map.setCellType(c, r, state);
        this.grid_map.setCellOwner(c, r, owner);
    }

    changeFoodCell(c, r, typeId, nutrition, owner=null) {
        this.grid_map.setCellFood(c, r, typeId, nutrition);
        this.grid_map.setCellOwner(c, r, owner);
    }
}


module.exports = Environment;