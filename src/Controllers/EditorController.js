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
        this._stopBrainGraphRefresh();

        const genome = brain && brain.genome;
        if (!genome) {
            brainInfo.html('<h2>Neural Brain</h2><p>No genome on this organism.</p>');
            this.updateBrainSummary();
            return;
        }

        const FEATURE_NAMES = [
            'empty','food0','food1','food2','food3',
            'wall','mouth','producer','emitter',
            'mover','killer','armor','eye',
            'dist','dx','dy'
        ];
        const INPUTS_PER_EYE = FEATURE_NAMES.length;

        const inputs   = genome.inputs;
        const outputs  = genome.outputs;
        const hiddens  = genome.hiddens;
        const conns    = genome.connections;
        const n_eyes   = brain.eye_cell_count || (inputs.length / INPUTS_PER_EYE) | 0;
        const n_hidden = hiddens.length;
        const n_movers = outputs.length;
        const n_enabled  = conns.filter(c => c.enabled).length;
        const n_disabled = conns.length - n_enabled;

        brainInfo.html(`
            <h2>Neural Brain (NEAT)</h2>
            <p style="margin:2px 0">Eyes: ${n_eyes} &nbsp; Hidden: ${n_hidden} &nbsp; Movers: ${n_movers}</p>
            <p style="margin:2px 0;font-size:11px;color:#aaa">Connections: ${n_enabled} enabled, ${n_disabled} disabled</p>
        `);

        if (inputs.length === 0 || n_movers === 0) {
            brainMaps.html('<p>No inputs and/or outputs yet — add an eye and a mover.</p>');
            this.updateBrainSummary();
            return;
        }

        // Build effective weight matrices from enabled connections. Disabled
        // entries display as 0 with a slightly different cell tint (no entry).
        // weightAt(src_id, dst_id) returns either a {weight, enabled} pair or null.
        const lookup = new Map();
        for (const c of conns) {
            lookup.set(c.src + "|" + c.dst, c);
        }
        const connAt = (src, dst) => lookup.get(src + "|" + dst) || null;

        function weightCell(c) {
            if (!c) {
                return `<td title="no connection" style="background:#1a1a1a;width:22px;height:14px;font-size:9px;text-align:center;color:#444">·</td>`;
            }
            const w = c.weight;
            const mag = Math.min(1, Math.abs(w) / 2);
            const r = w < 0 ? Math.round(180 * mag) : 0;
            const g = w > 0 ? Math.round(180 * mag) : 0;
            const opacity = c.enabled ? 1.0 : 0.35;
            return `<td title="${w.toFixed(3)}${c.enabled ? '' : ' (disabled)'}" style="background:rgba(${r},${g},0,${opacity});width:22px;height:14px;font-size:9px;text-align:center;color:#eee">${w.toFixed(1)}</td>`;
        }

        function activationCell(v) {
            const mag = Math.min(1, Math.abs(v));
            const r = v < 0 ? Math.round(200 * mag) : 0;
            const g = v > 0 ? Math.round(200 * mag) : 0;
            return `<td title="${v.toFixed(3)}" style="background:rgb(${r},${g},0);width:22px;height:14px;font-size:9px;text-align:center;color:#eee;border:1px solid #555">${v.toFixed(2)}</td>`;
        }

        // Pull activations from the compiled forward-pass buffer (zeros until
        // the organism has ticked at least once).
        const compiled = genome._compiled;
        const activations = compiled ? compiled.activations : null;
        const hidden_offset = compiled ? compiled.hidden_offset : 0;

        let hiddenActRow = '';
        for (let h = 0; h < n_hidden; h++) {
            const v = activations ? activations[hidden_offset + h] : 0;
            hiddenActRow += activationCell(v || 0);
        }
        let thrustActRow = '';
        for (let j = 0; j < n_movers; j++) {
            const t = (brain.last_thrusts && brain.last_thrusts[j] != null) ? brain.last_thrusts[j] : 0;
            thrustActRow += activationCell(t);
        }

        const actStyle = 'border-collapse:collapse;font-family:monospace;margin-bottom:2px';
        const actSection = n_hidden > 0
            ? `
                <p style="margin:4px 0 1px;font-size:11px;font-weight:bold;color:#ccc">Activations (last tick)</p>
                <table style="${actStyle}">
                    <tr><td style="font-size:10px;padding:1px 4px;white-space:nowrap;color:#aaa">hidden</td>${hiddenActRow}</tr>
                    <tr><td style="font-size:10px;padding:1px 4px;white-space:nowrap;color:#aaa">thrust</td>${thrustActRow}</tr>
                </table>
              `
            : `
                <p style="margin:4px 0 1px;font-size:11px;font-weight:bold;color:#ccc">Thrust (last tick)</p>
                <table style="${actStyle}">
                    <tr><td style="font-size:10px;padding:1px 4px;white-space:nowrap;color:#aaa">thrust</td>${thrustActRow}</tr>
                </table>
              `;

        const tableStyle = 'border-collapse:collapse;font-family:monospace';

        const inputLabel = (i) => {
            const e = (i / INPUTS_PER_EYE) | 0;
            const f =  i % INPUTS_PER_EYE;
            return n_eyes > 1 ? `E${e}·${FEATURE_NAMES[f]}` : FEATURE_NAMES[f];
        };

        // W1 table: input → hidden  (only shown if at least one hidden node exists)
        let w1Section = '';
        if (n_hidden > 0) {
            let w1Header = '<tr><th style="font-size:10px;padding:1px 3px">In \\ H</th>';
            for (let h = 0; h < n_hidden; h++) {
                w1Header += `<th title="${hiddens[h].id}" style="font-size:10px;padding:1px 3px">H${h}</th>`;
            }
            w1Header += '</tr>';
            let w1Rows = '';
            for (let i = 0; i < inputs.length; i++) {
                w1Rows += `<tr><td style="font-size:10px;padding:1px 3px;white-space:nowrap">${inputLabel(i)}</td>`;
                for (let h = 0; h < n_hidden; h++) {
                    w1Rows += weightCell(connAt(inputs[i], hiddens[h].id));
                }
                w1Rows += '</tr>';
            }
            w1Section = `
                <p style="margin:2px 0 1px;font-size:11px;font-weight:bold;color:#ccc">Input → Hidden</p>
                <table style="${tableStyle}">${w1Header}${w1Rows}</table>
            `;
        }

        // W2 table: hidden → output
        let w2Section = '';
        if (n_hidden > 0) {
            let w2Header = '<tr><th style="font-size:10px;padding:1px 3px">H \\ Out</th>';
            for (let j = 0; j < n_movers; j++) w2Header += `<th style="font-size:10px;padding:1px 3px">M${j}</th>`;
            w2Header += '</tr>';
            let w2Rows = '';
            for (let h = 0; h < n_hidden; h++) {
                w2Rows += `<tr><td title="${hiddens[h].id}" style="font-size:10px;padding:1px 3px">H${h}</td>`;
                for (let j = 0; j < n_movers; j++) {
                    w2Rows += weightCell(connAt(hiddens[h].id, outputs[j]));
                }
                w2Rows += '</tr>';
            }
            w2Section = `
                <p style="margin:6px 0 1px;font-size:11px;font-weight:bold;color:#ccc">Hidden → Output</p>
                <table style="${tableStyle}">${w2Header}${w2Rows}</table>
            `;
        }

        // Skip table: direct input → output connections (always shown — the
        // pure-NEAT minimal initial topology lives entirely here).
        let skipHeader = '<tr><th style="font-size:10px;padding:1px 3px">In \\ Out</th>';
        for (let j = 0; j < n_movers; j++) skipHeader += `<th style="font-size:10px;padding:1px 3px">M${j}</th>`;
        skipHeader += '</tr>';
        let skipRows = '';
        for (let i = 0; i < inputs.length; i++) {
            skipRows += `<tr><td style="font-size:10px;padding:1px 3px;white-space:nowrap">${inputLabel(i)}</td>`;
            for (let j = 0; j < n_movers; j++) {
                skipRows += weightCell(connAt(inputs[i], outputs[j]));
            }
            skipRows += '</tr>';
        }
        const skipSection = `
            <p style="margin:6px 0 1px;font-size:11px;font-weight:bold;color:#ccc">Input → Output (skip / direct)</p>
            <table style="${tableStyle}">${skipHeader}${skipRows}</table>
        `;

        // Brain graph SVG — live-updating visualisation of nodes and signal flow.
        // Built once with stable ids, then refreshed via _refreshBrainGraph().
        const graphSection = this._buildBrainGraphSVG(org);

        brainMaps.html(`
            <div style="overflow:auto;max-height:600px;margin-top:4px">
                <div style="display:flex; gap:10px; align-items:flex-start; flex-wrap:wrap">
                    <details open style="flex:1 1 auto; min-width:0">
                        <summary style="cursor:pointer;font-size:11px;color:#aaa;margin-bottom:4px;user-select:none">
                            Heatmap (click to collapse)
                        </summary>
                        ${actSection}
                        ${w1Section}
                        ${w2Section}
                        ${skipSection}
                    </details>
                    <div style="flex:0 0 auto">
                        ${graphSection}
                    </div>
                </div>
            </div>
        `);

        this._refreshBrainGraph(org);
        this._startBrainGraphRefresh(org);
        this.updateBrainSummary();
    }

    // ─── Brain graph (SVG) ───────────────────────────────────────────────

    /** Build the static SVG skeleton — nodes + connections — for `org`'s
     *  brain. Live colours / line widths are filled in by `_refreshBrainGraph`
     *  immediately afterward and on every poll tick. */
    _buildBrainGraphSVG(org) {
        const FEATURE_NAMES = [
            'empty','food0','food1','food2','food3',
            'wall','mouth','producer','emitter',
            'mover','killer','armor','eye',
            'dist','dx','dy',
        ];
        const INPUTS_PER_EYE = FEATURE_NAMES.length;

        const genome = org.brain.genome;
        const n_eyes   = org.brain.eye_cell_count || (genome.inputs.length / INPUTS_PER_EYE) | 0;
        const n_hidden = genome.hiddens.length;
        const n_movers = genome.outputs.length;

        // SVG height needs a bit more vertical room than activation-only
        // labels would require, since each hidden node now also shows its
        // τ value under the activation row.
        const W = 460, H = Math.max(280, 44 * Math.max(n_eyes, n_hidden, n_movers, 1) + 60);
        const COL_X = { eye: 60, hidden: 230, output: 400 };
        const NODE_R = 16;

        const yPositions = (n) => {
            if (n === 0) return [];
            if (n === 1) return [H / 2];
            const pad = 40;
            const step = (H - 2 * pad) / (n - 1);
            return Array.from({ length: n }, (_, i) => pad + step * i);
        };

        const eyeY    = yPositions(n_eyes);
        const hiddenY = yPositions(n_hidden);
        const outY    = yPositions(n_movers);

        // ── Build connection lines ───────────────────────────────────────
        // Eye→target connections are aggregated per (eye, target) pair: a
        // single line carries the dominant outgoing weight across that eye's
        // 16 input features. Hidden→output and any recurrent edges render
        // one line per genome connection.
        const lines = [];

        // helper: average weight from eye e to a target node id `dst`
        function aggEyeWeight(eyeIndex, dst) {
            let sum = 0;
            for (let f = 0; f < INPUTS_PER_EYE; f++) {
                const src = "i:" + eyeIndex + ":" + f;
                const conn = genome.connections.find(c => c.src === src && c.dst === dst && c.enabled);
                if (conn) sum += conn.weight;
            }
            return sum / INPUTS_PER_EYE;
        }

        // Eye → hidden
        for (let e = 0; e < n_eyes; e++) {
            for (let h = 0; h < n_hidden; h++) {
                const w = aggEyeWeight(e, genome.hiddens[h].id);
                lines.push({
                    id:    `bg-conn-eye${e}-h${h}`,
                    kind:  "eye2hidden",
                    x1: COL_X.eye + NODE_R, y1: eyeY[e],
                    x2: COL_X.hidden - NODE_R, y2: hiddenY[h],
                    weight: w,
                    eye: e, dstId: genome.hiddens[h].id,
                });
            }
        }
        // Eye → output (skip / direct)
        for (let e = 0; e < n_eyes; e++) {
            for (let o = 0; o < n_movers; o++) {
                const w = aggEyeWeight(e, genome.outputs[o]);
                if (Math.abs(w) < 1e-6) continue; // skip vanishing skip-connections
                lines.push({
                    id:    `bg-conn-eye${e}-o${o}`,
                    kind:  "eye2out",
                    x1: COL_X.eye + NODE_R, y1: eyeY[e],
                    x2: COL_X.output - NODE_R, y2: outY[o],
                    weight: w,
                    eye: e, dstId: genome.outputs[o],
                });
            }
        }
        // Hidden → output
        for (let h = 0; h < n_hidden; h++) {
            for (let o = 0; o < n_movers; o++) {
                const conn = genome.connections.find(c =>
                    c.src === genome.hiddens[h].id && c.dst === genome.outputs[o]
                );
                if (!conn) continue;
                lines.push({
                    id:    `bg-conn-h${h}-o${o}`,
                    kind:  "hidden2out",
                    x1: COL_X.hidden + NODE_R, y1: hiddenY[h],
                    x2: COL_X.output - NODE_R, y2: outY[o],
                    weight: conn.weight,
                    enabled: conn.enabled,
                    srcId: conn.src, dstId: conn.dst,
                });
            }
        }
        // Recurrent / lateral: hidden → hidden (currently rejected by Genome
        // but render if any sneak in — Phase 4+ might allow). Drawn as a
        // curved Bezier so it doesn't overlap straight feedforward lines.
        for (const c of genome.connections) {
            if (!c.src.startsWith("h:") || !c.dst.startsWith("h:")) continue;
            const sIdx = genome.hiddens.findIndex(x => x.id === c.src);
            const dIdx = genome.hiddens.findIndex(x => x.id === c.dst);
            if (sIdx < 0 || dIdx < 0) continue;
            const sy = hiddenY[sIdx], dy = hiddenY[dIdx];
            const bend = sIdx === dIdx ? 50 : 30 * (sy < dy ? 1 : -1);
            lines.push({
                id:    `bg-conn-h${sIdx}-h${dIdx}-rec`,
                kind:  "recurrent",
                x1: COL_X.hidden, y1: sy,
                x2: COL_X.hidden, y2: dy,
                cx: COL_X.hidden + 70, cy: (sy + dy) / 2 + bend,
                weight: c.weight,
                enabled: c.enabled,
                srcId: c.src, dstId: c.dst,
            });
        }

        // ── Render SVG ──────────────────────────────────────────────────
        let svg = `<svg id="brain-graph-svg" width="${W}" height="${H}" `
                + `viewBox="0 0 ${W} ${H}" style="background:#111;border:1px solid #333;border-radius:4px;display:block;margin-bottom:6px">`
                + `<defs>`
                + `  <marker id="bg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">`
                + `    <path d="M0,0 L10,5 L0,10 Z" fill="#888" /></marker>`
                + `</defs>`;

        // Column labels
        svg += `<text x="${COL_X.eye}"    y="20" fill="#aaa" font-size="11" text-anchor="middle">Eyes</text>`;
        svg += `<text x="${COL_X.hidden}" y="20" fill="#aaa" font-size="11" text-anchor="middle">Hidden</text>`;
        svg += `<text x="${COL_X.output}" y="20" fill="#aaa" font-size="11" text-anchor="middle">Movers</text>`;

        // Connections first so nodes draw on top
        for (const ln of lines) {
            if (ln.kind === "recurrent") {
                const d = `M ${ln.x1 + NODE_R/2},${ln.y1} Q ${ln.cx},${ln.cy} ${ln.x2 + NODE_R/2},${ln.y2}`;
                svg += `<path id="${ln.id}" d="${d}" stroke="#444" stroke-width="1" fill="none" marker-end="url(#bg-arrow)"><title>recurrent</title></path>`;
            } else {
                svg += `<line id="${ln.id}" x1="${ln.x1}" y1="${ln.y1}" x2="${ln.x2}" y2="${ln.y2}" stroke="#444" stroke-width="1"><title></title></line>`;
            }
        }

        // Eye nodes
        for (let e = 0; e < n_eyes; e++) {
            svg += `<g id="bg-eye-${e}">`;
            svg += `  <circle cx="${COL_X.eye}" cy="${eyeY[e]}" r="${NODE_R}" fill="#222" stroke="#999" stroke-width="1.5" />`;
            svg += `  <text x="${COL_X.eye}" y="${eyeY[e] + 4}" fill="#eee" font-size="11" text-anchor="middle" font-family="monospace">E${e}</text>`;
            svg += `  <text id="bg-eye-${e}-lbl" x="${COL_X.eye}" y="${eyeY[e] + NODE_R + 12}" fill="#888" font-size="9" text-anchor="middle">—</text>`;
            svg += `</g>`;
        }
        // Hidden nodes — border colour + width encode the CTRNN time
        // constant τ. Cool blue = fast / short-memory (τ near minTau),
        // warm red = slow / long-memory (τ near maxTau). Thicker border =
        // longer memory horizon. τ value is shown below the activation.
        const minTau = (typeof Hyperparams !== "undefined" && Hyperparams.ctrnnMinTau != null) ? Hyperparams.ctrnnMinTau : 1.0;
        const maxTau = (typeof Hyperparams !== "undefined" && Hyperparams.ctrnnMaxTau != null) ? Hyperparams.ctrnnMaxTau : 8.0;
        const tauColour = (tau) => {
            const t = Math.min(1, Math.max(0, (tau - minTau) / Math.max(0.001, (maxTau - minTau))));
            const r = Math.round(60  + 200 * t);
            const g = Math.round(140 - 60  * Math.abs(t - 0.5) * 2);
            const b = Math.round(230 - 210 * t);
            return { stroke: `rgb(${r},${g},${b})`, width: (1.5 + t * 2.5).toFixed(2) };
        };
        for (let h = 0; h < n_hidden; h++) {
            const tau = (genome.hiddens[h] && genome.hiddens[h].tau != null) ? genome.hiddens[h].tau : 1.0;
            const tc  = tauColour(tau);
            svg += `<g id="bg-h-${h}">`;
            svg += `  <circle cx="${COL_X.hidden}" cy="${hiddenY[h]}" r="${NODE_R}" fill="#222" stroke="${tc.stroke}" stroke-width="${tc.width}"><title>τ=${tau.toFixed(2)}</title></circle>`;
            svg += `  <text x="${COL_X.hidden}" y="${hiddenY[h] + 4}" fill="#eee" font-size="11" text-anchor="middle" font-family="monospace">H${h}</text>`;
            svg += `  <text id="bg-h-${h}-lbl" x="${COL_X.hidden}" y="${hiddenY[h] + NODE_R + 12}" fill="#888" font-size="9" text-anchor="middle">0.00</text>`;
            svg += `  <text id="bg-h-${h}-tau" x="${COL_X.hidden}" y="${hiddenY[h] + NODE_R + 22}" fill="${tc.stroke}" font-size="9" text-anchor="middle" font-family="monospace">τ=${tau.toFixed(1)}</text>`;
            svg += `</g>`;
        }
        // Output nodes
        for (let o = 0; o < n_movers; o++) {
            svg += `<g id="bg-o-${o}">`;
            svg += `  <circle cx="${COL_X.output}" cy="${outY[o]}" r="${NODE_R}" fill="#222" stroke="#999" stroke-width="1.5" />`;
            svg += `  <text x="${COL_X.output}" y="${outY[o] + 4}" fill="#eee" font-size="11" text-anchor="middle" font-family="monospace">M${o}</text>`;
            svg += `  <text id="bg-o-${o}-lbl" x="${COL_X.output}" y="${outY[o] + NODE_R + 12}" fill="#888" font-size="9" text-anchor="middle">0.00</text>`;
            svg += `</g>`;
        }
        svg += `</svg>`;

        // Cache the parameters the refresh function needs.
        this._brainGraph = {
            org, n_eyes, n_hidden, n_movers, lines, INPUTS_PER_EYE, FEATURE_NAMES,
            // colour palette for input features (matches food cell colours)
            featureColour: {
                food0: "#2F7AB7", food1: "#FF69B4", food2: "#FF0000", food3: "#FFFF00",
                killer: "#F2317A", wall: "#888888", mouth: "#DE3641", producer: "#15DE59",
                emitter: "#FFFFFF", mover: "#60D4FF", armor: "#7230DB", eye: "#FFFFFF",
                empty: "#333333",
            },
        };
        return svg;
    }

    /** The editor panel always renders against a *copy* of the clicked
     *  organism (OrganismEditor.setOrganismToCopyOf). That copy never ticks,
     *  so its activations are frozen. For the live graph we look up the real
     *  organism in the world env via the environment controller's
     *  `cur_org` reference — that one IS being ticked and its
     *  `brain.genome._compiled.activations` advances every simulation step. */
    _liveOrganismFor(editor_org) {
        try {
            const live = this.env
                && this.env.engine
                && this.env.engine.controlpanel
                && this.env.engine.controlpanel.env_controller
                && this.env.engine.controlpanel.env_controller.cur_org;
            if (live && live.living) return live;
        } catch (_) { /* fall through */ }
        return editor_org;
    }

    /** Recompute live colours and line widths from the brain's current
     *  compiled activations + last_thrusts. Called on a polling timer so the
     *  visualisation tracks the simulation in real time. */
    _refreshBrainGraph(editor_org) {
        const cfg = this._brainGraph;
        if (!cfg) return;
        const org = this._liveOrganismFor(editor_org);
        const brain = org.brain;
        const genome = brain && brain.genome;
        if (!genome) return;
        const compiled = genome._compiled;
        const acts = compiled ? compiled.activations : null;
        const INPUTS_PER_EYE = cfg.INPUTS_PER_EYE;
        const FEAT = cfg.FEATURE_NAMES;
        const palette = cfg.featureColour;

        const lerp = (a, b, t) => a + (b - a) * t;
        const colorForActivation = (v) => {
            // green for positive, red for negative, dark for zero.
            const mag = Math.min(1, Math.abs(v));
            if (v >= 0) {
                const r = Math.round(lerp(34, 30, mag));
                const g = Math.round(lerp(34, 220, mag));
                const b = Math.round(lerp(34, 30, mag));
                return `rgb(${r},${g},${b})`;
            } else {
                const r = Math.round(lerp(34, 230, mag));
                const g = Math.round(lerp(34, 30, mag));
                const b = Math.round(lerp(34, 30, mag));
                return `rgb(${r},${g},${b})`;
            }
        };

        // ── Eye nodes: colour by dominant feature being observed ─────────
        for (let e = 0; e < cfg.n_eyes; e++) {
            const base = e * INPUTS_PER_EYE;
            // Inputs 0..12 are one-hot cell-type features; pick the index with
            // activation 1.0 (or the largest if multiple).
            let topF = -1, topV = 0;
            if (acts) {
                for (let f = 0; f < 13; f++) {
                    const v = acts[base + f] || 0;
                    if (v > topV) { topV = v; topF = f; }
                }
            }
            const featName = (topF >= 0) ? FEAT[topF] : "—";
            const col = (topV > 0.5 && palette[featName]) ? palette[featName] : "#222";
            const $g = $(`#bg-eye-${e}`);
            $g.find("circle").attr("fill", col).attr("stroke", topV > 0.5 ? "#fff" : "#999");
            // distance / dx / dy stay encoded as small text suffix
            let suffix = "";
            if (acts && topV > 0.5) {
                const dist = acts[base + 13] || 0;
                suffix = ` d${dist.toFixed(2)}`;
            }
            $(`#bg-eye-${e}-lbl`).text((topF >= 0 ? featName : "empty") + suffix);
        }

        // ── Hidden nodes: colour the FILL by signed activation magnitude.
        // We leave the circle's stroke alone — it was set at build time to
        // encode τ (cool=fast, warm=slow) and τ doesn't change during the
        // organism's lifetime, so it stays a stable visual cue.
        const hidden_offset = compiled ? compiled.hidden_offset : 0;
        for (let h = 0; h < cfg.n_hidden; h++) {
            const v = acts ? acts[hidden_offset + h] : 0;
            $(`#bg-h-${h}`).find("circle").attr("fill", colorForActivation(v));
            $(`#bg-h-${h}-lbl`).text(v.toFixed(2));
        }

        // ── Output nodes: colour by last_thrusts ─────────────────────────
        for (let o = 0; o < cfg.n_movers; o++) {
            const t = (brain.last_thrusts && brain.last_thrusts[o] != null) ? brain.last_thrusts[o] : 0;
            $(`#bg-o-${o}`).find("circle").attr("fill", colorForActivation(t));
            $(`#bg-o-${o}-lbl`).text(t.toFixed(2));
        }

        // ── Connection lines: width + colour by current signal flow ──────
        // For eye-sourced lines, flow = aggregate (weight × observed input)
        // across that eye's 16 features. For hidden-sourced lines, flow =
        // weight × source-hidden activation (recurrent edges show the value
        // the next tick would actually integrate — i.e. last tick's hidden
        // activation — which is what `_prev_hidden_acts` carries).
        const flowFor = (ln) => {
            if (!acts) return 0;
            if (ln.kind === "eye2hidden" || ln.kind === "eye2out") {
                const base = ln.eye * INPUTS_PER_EYE;
                let sum = 0;
                for (let f = 0; f < INPUTS_PER_EYE; f++) {
                    const src = "i:" + ln.eye + ":" + f;
                    const conn = genome.connections.find(c =>
                        c.src === src && c.dst === ln.dstId && c.enabled
                    );
                    if (conn) sum += conn.weight * (acts[base + f] || 0);
                }
                return sum;
            }
            if (ln.kind === "hidden2out" || ln.kind === "recurrent") {
                if (!ln.srcId.startsWith("h:")) return 0;
                const hIdx = genome.hiddens.findIndex(x => x.id === ln.srcId);
                if (hIdx < 0) return 0;
                const srcAct = ln.kind === "recurrent" && genome._prev_hidden_acts
                    ? genome._prev_hidden_acts[hIdx]
                    : acts[hidden_offset + hIdx];
                return (srcAct || 0) * ln.weight;
            }
            return 0;
        };

        for (const ln of cfg.lines) {
            const flow = flowFor(ln);
            const mag = Math.min(1, Math.abs(flow) / 2);
            const w = Math.max(0.5, mag * 4);
            const colour = flow >= 0
                ? `rgba(60,220,90,${0.3 + 0.7 * mag})`
                : `rgba(230,80,80,${0.3 + 0.7 * mag})`;
            const $el = $("#" + ln.id);
            if (ln.kind === "recurrent") {
                $el.attr("stroke", colour).attr("stroke-width", w);
            } else {
                $el.attr("stroke", colour).attr("stroke-width", w);
            }
            $el.find("title").text(`w=${ln.weight.toFixed(2)}  flow=${flow.toFixed(2)}`);
        }
    }

    _startBrainGraphRefresh(org) {
        this._stopBrainGraphRefresh();
        // Poll at ~7 Hz — fast enough that thrust changes look continuous,
        // slow enough that refreshing dozens of SVG attributes doesn't hurt
        // sim throughput. We refresh in place, no DOM rebuild.
        this._brainGraphInterval = setInterval(() => {
            // Skip if the SVG was removed from the DOM (panel closed).
            if (!document.getElementById("brain-graph-svg")) {
                this._stopBrainGraphRefresh();
                return;
            }
            try { this._refreshBrainGraph(org); }
            catch (e) { this._stopBrainGraphRefresh(); }
        }, 140);
    }

    _stopBrainGraphRefresh() {
        if (this._brainGraphInterval) {
            clearInterval(this._brainGraphInterval);
            this._brainGraphInterval = null;
        }
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

            // draw mover thrust arrows — length and color encode last-tick thrust
            ctx.setLineDash([]);
            const lastThrusts = org.brain.last_thrusts;
            let mover_idx = 0;
            for (const moverLocal of movers) {
                const realCell = org.getRealCell(moverLocal);
                if (!realCell || typeof moverLocal.getAbsoluteDirection !== 'function') { mover_idx++; continue; }
                const cx = realCell.x + half;
                const cy = realCell.y + half;
                const absDir = moverLocal.getAbsoluteDirection();
                const vec = Directions.scalars[absDir];
                if (!vec) { mover_idx++; continue; }
                const [dx, dy] = vec;

                const thrust = (lastThrusts && mover_idx < lastThrusts.length) ? lastThrusts[mover_idx] : 0;
                const mag    = Math.abs(thrust);
                // minimum 20 % length so the arrow is always visible even at low thrust
                const arrowLen = half * 1.6 * Math.max(0.2, mag);
                const ex = cx + dx * arrowLen;
                const ey = cy + dy * arrowLen;

                // cyan = forward thrust, orange = reverse
                const color = thrust >= 0 ? 'rgba(0,220,255,0.9)' : 'rgba(255,140,0,0.9)';
                ctx.strokeStyle = color;
                ctx.fillStyle   = color;
                ctx.lineWidth   = 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(ex, ey);
                ctx.stroke();

                // arrowhead (skip when thrust is negligible)
                if (mag > 0.05) {
                    const headLen = Math.max(3, half * 0.5);
                    const angle = Math.atan2(ey - cy, ex - cx);
                    ctx.beginPath();
                    ctx.moveTo(ex, ey);
                    ctx.lineTo(ex - headLen * Math.cos(angle - 0.4), ey - headLen * Math.sin(angle - 0.4));
                    ctx.lineTo(ex - headLen * Math.cos(angle + 0.4), ey - headLen * Math.sin(angle + 0.4));
                    ctx.closePath();
                    ctx.fill();
                }

                // thrust value label inside the mover cell
                if (cs >= 8) {
                    ctx.fillStyle = 'rgba(255,255,255,0.9)';
                    ctx.font = `bold ${Math.max(7, Math.floor(cs * 0.38))}px monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(thrust.toFixed(2), cx, cy);
                }

                mover_idx++;
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
