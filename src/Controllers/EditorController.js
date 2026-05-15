const CanvasController = require("./CanvasController");
const CellStates = require("../Organism/Cell/CellStates");
const Directions = require("../Organism/Directions");
const Hyperparams = require("../Hyperparameters");
const Species = require("../Stats/Species");
const LoadController = require("./LoadController");
const FSMBrain = require("../Organism/Perception/FSMBrain");
const NNBrain = require("../Organism/Perception/NNBrain");
const FossilRecord = require("../Stats/FossilRecord");

class EditorController extends CanvasController{
    constructor(env, canvas) {
        super(env, canvas);
        this.edit_cell_type = null;
        this.edit_diet = 0;
        this.highlight_org = false;
        this.defineCellTypeSelection();
        this.defineEditorDetails();
        this.defineSaveLoad();
        // restore eye highlight after mouse leaves canvas
        this.canvas.addEventListener('mouseleave', () => {
            if (this.env.engine && this.env.engine.controlpanel && this.env.engine.controlpanel.brain_editor_open) {
                this.highlightEye(this.current_eye_index || 0);
            }
        });
    }

    mouseMove() {
        if (this.right_click || this.left_click)
            this.editOrganism();
    }

    mouseDown() {
        this.editOrganism();
    }

    mouseUp(){}

    getCurLocalCell(){
        return this.env.organism.anatomy.getLocalCell(this.mouse_c-this.env.organism.c, this.mouse_r-this.env.organism.r);
    }

    editOrganism() {
        const controlpanelOpen = this.env.engine && this.env.engine.controlpanel && this.env.engine.controlpanel.brain_editor_open;
        if (this.edit_cell_type == null) return;
        if (this.left_click){
            if(this.edit_cell_type == CellStates.eye && this.cur_cell.state == CellStates.eye) {
                var loc_cell = this.getCurLocalCell();
                loc_cell.direction = Directions.rotateRight(loc_cell.direction);
                this.env.renderFull();
            } else if (this.edit_cell_type == CellStates.mouth && this.cur_cell.state == CellStates.mouth) {
                var loc_cell = this.getCurLocalCell();
                if (loc_cell) {
                    loc_cell.diet = this.edit_diet;
                    this.env.organism.brain.onDietChanged && this.env.organism.brain.onDietChanged();
                    this.env.renderFull();
                }
            } else {
                this.env.addCellToOrg(this.mouse_c, this.mouse_r, this.edit_cell_type);
                if (this.edit_cell_type == CellStates.mouth) {
                    var loc_cell = this.getCurLocalCell();
                    if (loc_cell) {
                        loc_cell.diet = this.edit_diet;
                        this.env.organism.brain.onDietChanged && this.env.organism.brain.onDietChanged();
                        this.env.renderFull();
                    }
                }
            }
        }
        else if (this.right_click)
            this.env.removeCellFromOrg(this.mouse_c, this.mouse_r);


        this.updateDetails();
        if (controlpanelOpen) {
            this.highlightEye(this.current_eye_index || 0);
        }
    }

    updateDetails() {
        $('.species-name').text("Species name: "+this.env.organism.species.name);
        $('.cell-count').text("Cell count: "+this.env.organism.anatomy.cells.length);
        if (this.env.organism.isNatural()){
            $('#unnatural-org-warning').css('display', 'none');
        }
        else {
            $('#unnatural-org-warning').css('display', 'block');
        }
        this.updateBrainInfo();
        this.updateBrainSummary();
        if (this.env.organism.brain instanceof NNBrain) {
            this.drawNNOverlay(this.env.organism);
        }
    }

    updateBrainSummary() {
        const org = this.env.organism;
        let summaryText;
        if (org.anatomy && org.anatomy.has_eyes && org.anatomy.is_mover) {
            // ensure counts are up to date
            if (org.brain && typeof org.brain.countCells === 'function') {
                org.brain.countCells();
            }
            const eyes = org.brain ? org.brain.eye_cell_count : 0;
            const states = org.brain ? org.brain.num_states : 0;
            summaryText = `Number of Eyes: ${eyes}<br>Number of Brain States: ${states}`;
        } else {
            summaryText = 'No brain';
        }
        // Update in both organism and editor detail panels if they exist
        ['#organism-details', '#edit-organism-details'].forEach(sel => {
            const cont = $(`${sel} .brain-details`);
            if (!cont.length) return;
            cont.find('.brain-info-summary').remove();
            cont.append(`<p class="brain-info-summary">${summaryText}</p>`);
        });
    }

    defineCellTypeSelection() {
        var self = this;
        $('.cell-type').click( function() {
            switch(this.id){
                case "mouth-0":
                case "mouth-1":
                case "mouth-2":
                case "mouth-3":
                    self.edit_cell_type = CellStates.mouth;
                    self.edit_diet = parseInt(this.id.split('-')[1]);
                    break;
                case "producer":
                    self.edit_cell_type = CellStates.producer;
                    break;
                case "mover":
                    self.edit_cell_type = CellStates.mover;
                    break;
                case "killer":
                    self.edit_cell_type = CellStates.killer;
                    break;
                case "armor":
                    self.edit_cell_type = CellStates.armor;
                    break;
                case "eye":
                    self.edit_cell_type = CellStates.eye;
                    break;
            }
            $(".cell-type").css("border-color", "black");
            $('#'+this.id+'.cell-type').css("border-color", "yellow");
        });
    }

    defineEditorDetails() {
        this.edit_details_html = $('#edit-organism-details');

        this.decision_names = ["ignore", "move away", "move towards"];

        $('#species-name-edit').on('focusout', function() {
            const new_name = $('#species-name-edit').val();
            if (new_name === '' || new_name === this.env.organism.species.name)
                return;
            FossilRecord.changeSpeciesName(this.env.organism.species, new_name);
        }.bind(this));

        $('#mutation-rate-edit').change ( function() {
            this.env.organism.mutability = parseInt($('#mutation-rate-edit').val());
        }.bind(this));
        $('#observation-type-edit').change ( function() {
            this.setBrainEditorValues($('#observation-type-edit').val());
        }.bind(this));
        $('#reaction-edit').change ( function() {
            var obs = $('#observation-type-edit').val();
            var decision = parseInt($('#reaction-edit').val());
            this.env.organism.brain.decisions[obs] = decision;
        }.bind(this));
    }

    defineSaveLoad() {
        $('#save-org').click(()=>{
            let org = this.env.organism.serialize();
            let data = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(org));
            let downloadEl = document.getElementById('download-el');
            downloadEl.setAttribute("href", data);
            const name = this.env.organism.species.name ? this.env.organism.species.name : "organism";
            downloadEl.setAttribute("download", name+".json");
            downloadEl.click();
        });
        $('#load-org').click(() => {
            LoadController.loadJson((org)=>{
                this.loadOrg(org);
            });
        });
    }

    loadOrg(org) {
        this.env.clear();
        this.env.organism.loadRaw(org);
        this.setEditorPanel();
        this.env.organism.updateGrid();
        this.env.renderFull();
        this.env.organism.species = new Species(this.env.organism.anatomy, null, 0);
        if (org.species_name)
            this.env.organism.species.name = org.species_name;
    }

    clearDetailsPanel() {
        this.updateDetails();
        $('#edit-organism-details').css('display', 'none');
        $('#randomize-organism-details').css('display', 'none');
    }

    setEditorPanel() {
        this.clearDetailsPanel();
        var org = this.env.organism;

        $('#species-name-edit').val(org.species.name);
        $('.cell-count').text("Cell count: "+org.anatomy.cells.length);

        $('#mutation-rate-edit').val(org.mutability);
        if (Hyperparams.useGlobalMutability) {
            $('#mutation-rate-cont').css('display', 'none');
        }
        else {
            $('#mutation-rate-cont').css('display', 'block');
        }

        $('#cell-selections').css('display', 'grid');
        this.updateBrainInfo();
        $('#edit-organism-details').css('display', 'block');
        if (this.env.organism.brain instanceof NNBrain) {
            this.drawNNOverlay(this.env.organism);
        }
    }

    setBrainEditorValues(name) {
        $('#observation-type-edit').val(name);
        var reaction = this.env.organism.brain.decisions[name];
        $('#reaction-edit').val(reaction);
    }

    updateBrainInfo() {
        const org = this.env.organism;
        org.brain.countCells();
        const brainInfo = $('#brain-info');
        const brainMaps = $('#brain-maps');
        brainMaps.empty();
        $('#brain-editor-controls').remove();

        if (!org.anatomy.has_eyes || !org.anatomy.is_mover) {
            brainInfo.html('<h2>Brain</h2><p>Add 1 eye and 1 mover to add a brain</p>');
            return;
        }

        if (org.brain instanceof NNBrain) {
            this.updateNNBrainPanel(org);
            return;
        }

        let eyeOptions = '';
        for (let i = 0; i < org.brain.eye_cell_count; i++) {
            eyeOptions += `<option value="${i}">Eye ${i}</option>`;
        }

        brainInfo.html(`
            <h2>Brain</h2>
            <span id="independent-eye-container" style="margin-left:8px; display:inline-flex; align-items:center; height:26px;">
                <span>Independent Eye Decisions</span>
                <input type="checkbox" id="independent-eye-checkbox" style="margin-left:4px;" title="When on, each eye cell has its own independent set of decisions." ${org.brain.independent_eye_decisions ? 'checked' : ''}>
            </span>
            <label id="eye-select-label" for="eye-select">Viewing Decisions for</label>
            <select id="eye-select">${eyeOptions}</select>
        `);
        
        this.generateDecisionMaps(0);

        $('#eye-select').change(() => {
            this.generateDecisionMaps(parseInt($('#eye-select').val()));
        });

        // toggle independent eye decisions checkbox handler
        $('#independent-eye-checkbox').off('change').change(() => {
            const checked = $('#independent-eye-checkbox').is(':checked');
            org.brain.setIndependentEyeDecisions(checked);
            // refresh eye options visibility
            if (checked) {
                $('#eye-select').show();
                $('#eye-select-label').show();
            } else {
                $('#eye-select').hide();
                $('#eye-select-label').hide();
                $('#eye-select').val('0');
                this.generateDecisionMaps(0);
            }
            this.updateBrainSummary();
        });

        // initialize visibility based on current mode
        if (!org.brain.independent_eye_decisions) {
            $('#eye-select').hide();
            $('#eye-select-label').hide();
        }

        // Brain controls: Add State button and Current State selector
        const controls = $('<div id="brain-editor-controls" style="margin-top:5px;display:flex;align-items:center;gap:10px;"></div>');
        const addStateBtn = $('<button id="add-brain-state" class="brain-editor-btn">Add Brain State</button>');
        const stateLabel = $('<label for="current-state-select">Current State:</label>');
        const stateSelect = $('<select id="current-state-select" class="brain-editor-btn"></select>');
        for (let i = 0; i < org.brain.num_states; i++) {
            stateSelect.append(`<option value="${i}" ${org.brain.state === i ? 'selected' : ''}>${i}</option>`);
        }
        controls.append(addStateBtn, stateLabel, stateSelect);
        brainMaps.after(controls);
        addStateBtn.click(() => {
            this.env.organism.brain.newBrainState(false);
            this.updateBrainInfo();
        });
        stateSelect.change(() => {
            const val = parseInt($('#current-state-select').val());
            this.env.organism.brain.state = val;
        });
        this.updateBrainSummary();
    }

    highlightEye(eyeIndex){
        // only if brain editor open
        if (!(this.env.engine && this.env.engine.controlpanel && this.env.engine.controlpanel.brain_editor_open)) {
            return;
        }
        const org = this.env.organism;
        const eyes = [];
        for (let cell of org.anatomy.cells){
            if (cell.state === CellStates.eye){
                eyes.push(cell);
            }
        }
        if (eyeIndex < 0 || eyeIndex >= eyes.length) return;
        const eyeLocal = eyes[eyeIndex];
        const realCell = org.getRealCell(eyeLocal);
        if (!realCell) return;

        // remove previous eye highlight but keep other highlights (e.g., hover)
        if (this._prevEyeHighlight){
            // redraw the cell in its normal state and remove from renderer's highlighted set
            this.env.renderer.renderCell(this._prevEyeHighlight);
            this.env.renderer.highlighted_cells.delete(this._prevEyeHighlight);
        }

        // add new highlight
        this.env.renderer.highlightCell(realCell);
        // ensure it shows up immediately
        this.env.renderer.renderHighlights();
        this._prevEyeHighlight = realCell;
    }

    updateMouseLocation(offsetX, offsetY) {
        super.updateMouseLocation(offsetX, offsetY);
        if (this.env.engine && this.env.engine.controlpanel && this.env.engine.controlpanel.brain_editor_open) {
            this.highlightEye(this.current_eye_index || 0);
        }
    }

    generateDecisionMaps(eyeIndex) {
        this.current_eye_index = eyeIndex;
        // highlight corresponding eye when panel is open
        this.highlightEye(eyeIndex);
        const org = this.env.organism;
        const brainMaps = $('#brain-maps');
        // clear previous handlers to avoid duplicates when regenerating
        brainMaps.off('change', '.action-select');
        brainMaps.off('change', '.state-select');
        brainMaps.off('click', '.remove-state-btn');
        brainMaps.empty();

        if (eyeIndex >= org.brain.decisions.length) return;

        const eyeDecisionMaps = org.brain.decisions[eyeIndex];

        for (let i = 0; i < eyeDecisionMaps.length; i++) {
            const stateMap = eyeDecisionMaps[i];
            let table = `
                <div class="decision-map">
                    <div class="decision-map-header"><h4>Brain State ${i}</h4>${org.brain.num_states > 1 ? `<button class=\"remove-state-btn\" data-state=\"${i}\">x</button>` : ''}</div>
                    <table>
                        <tr>
                            <th>Observation</th>
                            <th>Action</th>
                            <th>Next State</th>
                        </tr>
            `;

            for (const cellType in stateMap) {
                const decision = stateMap[cellType];
                table += `
                    <tr>
                        <td>${cellType}</td>
                        <td>${this.generateActionDropdown(eyeIndex, i, cellType, decision.decision)}</td>
                        <td>${this.generateStateDropdown(eyeIndex, i, cellType, decision.state)}</td>
                    </tr>
                `;
            }

            table += '</table></div>';
            brainMaps.append(table);
        }
        
        $('.remove-state-btn').click((e) => {
            const idx = parseInt($(e.target).data('state'));
            org.brain.removeBrainState(idx);
            this.updateBrainInfo();
        });

        $('.action-select, .state-select').change((e) => {
            const target = $(e.target);
            const eye = target.data('eye');
            const state = target.data('state');
            const cell = target.data('cell');
            const type = target.data('type');
            const value = parseInt(target.val());
            org.brain.decisions[eye][state][cell][type] = value;
        });
    }

    generateActionDropdown(eye, state, cell, selectedAction) {
        let options = '';
        for (const action in FSMBrain.Decision) {
            if (typeof FSMBrain.Decision[action] === 'number') {
                options += `<option value="${FSMBrain.Decision[action]}" ${selectedAction === FSMBrain.Decision[action] ? 'selected' : ''}>${action}</option>`;
            }
        }
        return `<select class="action-select" data-eye="${eye}" data-state="${state}" data-cell="${cell}" data-type="decision">${options}</select>`;
    }

    generateStateDropdown(eye, state, cell, selectedState) {
        let options = '';
        for (let i = 0; i < this.env.organism.brain.num_states; i++) {
            options += `<option value="${i}" ${selectedState === i ? 'selected' : ''}>${i}</option>`;
        }
        return `<select class="state-select" data-eye="${eye}" data-state="${state}" data-cell="${cell}" data-type="state">${options}</select>`;
    }

    updateNNBrainPanel(org) {
        const brain = org.brain;
        const brainInfo = $('#brain-info');
        const brainMaps = $('#brain-maps');
        brainMaps.empty();
        $('#brain-editor-controls').remove();

        const n_eyes   = brain.eye_cell_count;
        const n_hidden = brain.n_hidden;
        const n_movers = brain.n_outputs;
        const n_weights = brain.w1.length + brain.w2.length;

        const FEATURE_NAMES = [
            'empty','food0','food1','food2','food3',
            'wall','mouth','producer','emitter',
            'mover','killer','armor','eye',
            'dist','dx','dy'
        ];

        brainInfo.html(`
            <h2>Neural Brain</h2>
            <p style="margin:2px 0">Eyes: ${n_eyes} &nbsp; Hidden: ${n_hidden} &nbsp; Movers: ${n_movers} &nbsp; Weights: ${n_weights}</p>
            <p style="margin:2px 0;font-size:11px;color:#aaa">W1: inputs→hidden &nbsp;|&nbsp; W2: hidden→outputs</p>
        `);

        if (n_eyes === 0 || n_movers === 0 || n_hidden === 0) {
            brainMaps.html('<p>No weights yet.</p>');
            this.updateBrainSummary();
            return;
        }

        function weightCell(w) {
            const mag = Math.min(1, Math.abs(w) / 2);
            const r = w < 0 ? Math.round(180 * mag) : 0;
            const g = w > 0 ? Math.round(180 * mag) : 0;
            return `<td title="${w.toFixed(3)}" style="background:rgb(${r},${g},0);width:18px;height:14px;font-size:9px;text-align:center;color:#eee">${w.toFixed(1)}</td>`;
        }

        // W1 table: rows = inputs (eye × feature), cols = hidden neurons
        let w1Header = '<tr><th style="font-size:10px;padding:1px 3px">In \\ H</th>';
        for (let h = 0; h < n_hidden; h++) w1Header += `<th style="font-size:10px;padding:1px 3px">H${h}</th>`;
        w1Header += '</tr>';

        let w1Rows = '';
        for (let e = 0; e < n_eyes; e++) {
            for (let f = 0; f < FEATURE_NAMES.length; f++) {
                const i = e * FEATURE_NAMES.length + f;
                if (i >= brain.n_inputs) break;
                const label = n_eyes > 1 ? `E${e}·${FEATURE_NAMES[f]}` : FEATURE_NAMES[f];
                w1Rows += `<tr><td style="font-size:10px;padding:1px 3px;white-space:nowrap">${label}</td>`;
                for (let h = 0; h < n_hidden; h++) {
                    w1Rows += weightCell(brain.w1[i * n_hidden + h]);
                }
                w1Rows += '</tr>';
            }
        }

        // W2 table: rows = hidden neurons, cols = movers
        let w2Header = '<tr><th style="font-size:10px;padding:1px 3px">H \\ Out</th>';
        for (let j = 0; j < n_movers; j++) w2Header += `<th style="font-size:10px;padding:1px 3px">M${j}</th>`;
        w2Header += '</tr>';

        let w2Rows = '';
        for (let h = 0; h < n_hidden; h++) {
            w2Rows += `<tr><td style="font-size:10px;padding:1px 3px">H${h}</td>`;
            for (let j = 0; j < n_movers; j++) {
                w2Rows += weightCell(brain.w2[h * n_movers + j]);
            }
            w2Rows += '</tr>';
        }

        const tableStyle = 'border-collapse:collapse;font-family:monospace';
        brainMaps.html(`
            <div style="overflow:auto;max-height:320px;margin-top:4px">
                <p style="margin:2px 0 1px;font-size:11px;font-weight:bold;color:#ccc">W1 — input → hidden</p>
                <table style="${tableStyle}">${w1Header}${w1Rows}</table>
                <p style="margin:6px 0 1px;font-size:11px;font-weight:bold;color:#ccc">W2 — hidden → output</p>
                <table style="${tableStyle}">${w2Header}${w2Rows}</table>
            </div>
        `);

        this.updateBrainSummary();
    }

    drawNNOverlay(org) {
        const renderer = this.env.renderer;
        if (!renderer || !renderer.ctx) return;

        // ensure cells are rendered before drawing on top
        this.env.renderFull();

        const ctx = renderer.ctx;
        const cs = renderer.cell_size;
        const half = cs / 2;

        // collect eyes and movers from anatomy
        const eyes = [];
        const movers = [];
        for (const c of org.anatomy.cells) {
            if (c.state === CellStates.eye) eyes.push(c);
            else if (c.state === CellStates.mover) movers.push(c);
        }

        if (eyes.length === 0 && movers.length === 0) return;

        ctx.save();
        try {
            // draw eye rays
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(255,255,0,0.8)';
            ctx.lineWidth = 1.5;
            for (const eyeLocal of eyes) {
                const realCell = org.getRealCell(eyeLocal);
                if (!realCell || typeof eyeLocal.getAbsoluteDirection !== 'function') continue;
                const sx = realCell.x + half;
                const sy = realCell.y + half;
                const absDir = eyeLocal.getAbsoluteDirection();
                const vec = Directions.scalars[absDir];
                if (!vec) continue;
                const [dx, dy] = vec;
                const rayLen = Math.min(Hyperparams.lookRange, 40) * cs;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(sx + dx * rayLen, sy + dy * rayLen);
                ctx.stroke();
            }

            // draw mover direction arrows
            ctx.setLineDash([]);
            for (const moverLocal of movers) {
                const realCell = org.getRealCell(moverLocal);
                if (!realCell || typeof moverLocal.getAbsoluteDirection !== 'function') continue;
                const cx = realCell.x + half;
                const cy = realCell.y + half;
                const absDir = moverLocal.getAbsoluteDirection();
                const vec = Directions.scalars[absDir];
                if (!vec) continue;
                const [dx, dy] = vec;
                const arrowLen = half * 1.6;
                const ex = cx + dx * arrowLen;
                const ey = cy + dy * arrowLen;

                ctx.strokeStyle = 'rgba(0,220,255,0.9)';
                ctx.fillStyle  = 'rgba(0,220,255,0.9)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(ex, ey);
                ctx.stroke();

                // arrowhead
                const headLen = Math.max(3, half * 0.5);
                const angle = Math.atan2(ey - cy, ex - cx);
                ctx.beginPath();
                ctx.moveTo(ex, ey);
                ctx.lineTo(ex - headLen * Math.cos(angle - 0.4), ey - headLen * Math.sin(angle - 0.4));
                ctx.lineTo(ex - headLen * Math.cos(angle + 0.4), ey - headLen * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fill();
            }
        } catch (e) {
            console.error('drawNNOverlay error:', e);
        } finally {
            ctx.restore();
        }
    }

    setRandomizePanel() {
        this.clearDetailsPanel();
        $('#randomize-organism-details').css('display', 'block');
    }
}

module.exports = EditorController;
