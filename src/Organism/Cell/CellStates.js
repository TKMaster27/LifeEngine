// A cell state is used to differentiate type and render the cell
class CellState{
    constructor(name) {
        this.name = name;
        this.color = 'black';
    }

    render(ctx, cell, size) {
        ctx.fillStyle = this.color;
        ctx.fillRect(cell.x, cell.y, size, size);
    }
}

class Empty extends CellState {
    constructor() {
        super('empty');
    }
}
class Food extends CellState {
    constructor() {
        super('food');
        this.center_colours = {
            0: "#2F7AB7",
            1: "#e21bf8"
        };
        this.center_default = "#FFFFFF";
        
    }

    render(ctx, cell, size) {
        ctx.fillStyle = this.color;
        ctx.fillRect(cell.x, cell.y, size, size);
        if(size <= 2)
            return;

        const markerColor = this.center_colours[cell.foodType] || this.center_default;
        const markerSize = Math.max(1, Math.floor(size * 0.5));
        const offset = Math.floor((size - markerSize) / 2);

        ctx.fillStyle = markerColor;
        ctx.fillRect(cell.x + offset, cell.y + offset, markerSize, markerSize);
    }
}
class Wall extends CellState {
    constructor() {
        super('wall');
    }
}
class Mouth extends CellState {
    constructor() {
        super('mouth');
    }

    render(ctx, cell, size) {
        ctx.fillStyle = this.color;
        ctx.fillRect(cell.x, cell.y, size, size);
        if (size <= 2) return;

        const diet = (cell.cell_owner && typeof cell.cell_owner.diet === "number")
            ? cell.cell_owner.diet
            : 0;

        const foodColors = CellStates.food.center_colours || {};
        const markerColor = foodColors[diet] || "#FFFFFF";
        const markerSize = Math.max(1, Math.floor(size * 0.5));
        const offset = Math.floor((size - markerSize) / 2);

        ctx.fillStyle = markerColor;
        ctx.fillRect(cell.x + offset, cell.y + offset, markerSize, markerSize);
    }
}
class Producer extends CellState {
    constructor() {
        super('producer');
    }
}
class Mover extends CellState {
    constructor() {
        super('mover');
    }
}
class Killer extends CellState {
    constructor() {
        super('killer');
    }
}
class Armor extends CellState {
    constructor() {
        super('armor');
    }
}
class Eye extends CellState {
    constructor() {
        super('eye');
        this.slit_color = 'black';
    }
    render(ctx, cell, size) {
        ctx.fillStyle = this.color;
        ctx.fillRect(cell.x, cell.y, size, size);
        if(size <= 1)
            return;
        var half = size/2;
        var x = -(size)/8
        var y = -half;
        var h = size/2 + size/4;
        var w = size/4;
        ctx.translate(cell.x+half, cell.y+half);
        ctx.rotate((cell.cell_owner.getAbsoluteDirection() * 90) * Math.PI / 180);
        ctx.fillStyle = this.slit_color;
        ctx.fillRect(x, y, w, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}

const CellStates = {
    empty: new Empty(),
    food: new Food(),
    wall: new Wall(),
    mouth: new Mouth(),
    producer: new Producer(),
    mover: new Mover(),
    killer: new Killer(),
    armor: new Armor(),
    eye: new Eye(),
    defineLists() {
        this.all = [this.empty, this.food, this.wall, this.mouth, this.producer, this.mover, this.killer, this.armor, this.eye]
        this.living = [this.mouth, this.producer, this.mover, this.killer, this.armor, this.eye];
    },
    getRandomName: function() {
        return this.all[Math.floor(Math.random() * this.all.length)].name;
    },
    getRandomLivingType: function() {
        return this.living[Math.floor(Math.random() * this.living.length)];
    }
}

CellStates.defineLists();

module.exports = CellStates;
