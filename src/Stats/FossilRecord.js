const CellStates = require("../Organism/Cell/CellStates");
const SerializeHelper = require("../Utils/SerializeHelper");
const Species = require("./Species");

const FossilRecord = {
    init: function(){
        this.extant_species = {};
        this.extinct_species = {};

        // if an organism has fewer than this cumulative pop, discard them on extinction
        this.min_discard = 10;

        this.record_size_limit = 500; // store this many data points
    },

    setEnv: function(env) {
        this.env = env;
        this.setData();
    },

    addSpecies: function(org, ancestor) {
        var new_species = new Species(org.anatomy, ancestor, this.env.total_ticks);
        // capture founder brain weights for post-run analysis
        if (org.brain && typeof org.brain.serialize === 'function') {
            new_species.founder_brain = org.brain.serialize();
        }
        this.extant_species[new_species.name] = new_species;
        org.species = new_species;
        return new_species;
    },

    addSpeciesObj: function(species) {
        if (this.extant_species[species.name]) {
            console.warn('Tried to add already existing species. Add failed.');
            return;
        }
        this.extant_species[species.name] = species;
        return species;
    },

    changeSpeciesName: function(species, new_name) {
        if (this.extant_species[new_name]) {
            console.warn('Tried to change species name to an existing species name. Change failed.');
            return;
        }
        delete this.extant_species[species.name];
        species.name = new_name;
        this.extant_species[new_name] = species;
    },

    numExtantSpecies() {return Object.values(this.extant_species).length},
    numExtinctSpecies() {return Object.values(this.extinct_species).length},
    speciesIsExtant(species_name) {return !!this.extant_species[species_name]},

    fossilize: function(species) {
        if (!this.extant_species[species.name]) {
            console.warn('Tried to fossilize non existing species.');
            return false;
        }
        species.end_tick = this.env.total_ticks;
        species.ancestor = undefined; // garbage collect ancestors
        delete this.extant_species[species.name];
        // Always retain extinct species so their founder_brain survives extinction.
        // min_discard is still used elsewhere to filter sparse species out of averages.
        this.extinct_species[species.name] = species;
        return species.cumulative_pop >= this.min_discard;
    },

    resurrect: function(species) {
        if (species.extinct) {
            species.extinct = false;
            this.extant_species[species.name] = species;
            delete this.extinct_species[species.name];
        }
    },

    setData() {
        // sliding-window arrays (capped at record_size_limit; used by the live in-browser charts)
        this.tick_record = [];
        this.pop_counts = [];
        this.species_counts = [];
        this.av_mut_rates = [];
        this.av_cells = [];
        this.av_cell_counts = [];
        this.species_diet_counts = [];
        this.population_diet_counts = [];
        this.av_connections = [];     // NEAT: avg enabled connections per organism
        this.av_hidden_nodes = [];    // NEAT: avg hidden nodes per organism
        // full-history arrays (never shifted; written to disk on serialize for post-run analysis)
        this.full_tick_record = [];
        this.full_pop_counts = [];
        this.full_species_counts = [];
        this.full_av_mut_rates = [];
        this.full_av_cells = [];
        this.full_av_cell_counts = [];
        this.full_species_diet_counts = [];
        this.full_population_diet_counts = [];
        this.full_av_connections = [];
        this.full_av_hidden_nodes = [];
        this.updateData();
    },

    updateData() {
        var tick = this.env.total_ticks;
        this.tick_record.push(tick);
        this.pop_counts.push(this.env.organisms.length);
        this.species_counts.push(this.numExtantSpecies());
        this.av_mut_rates.push(this.env.averageMutability());
        this.species_diet_counts.push(this.calcDietSpecializationCounts());
        this.population_diet_counts.push(this.calcPopulationDietCounts());
        this.calcCellCountAverages();
        this.calcBrainAverages();
        // mirror the just-pushed values into the full-history arrays before any shift.
        const last = this.tick_record.length - 1;
        this.full_tick_record.push(this.tick_record[last]);
        this.full_pop_counts.push(this.pop_counts[last]);
        this.full_species_counts.push(this.species_counts[last]);
        this.full_av_mut_rates.push(this.av_mut_rates[last]);
        this.full_av_cells.push(this.av_cells[last]);
        this.full_av_cell_counts.push(this.av_cell_counts[last]);
        this.full_species_diet_counts.push(this.species_diet_counts[last]);
        this.full_population_diet_counts.push(this.population_diet_counts[last]);
        this.full_av_connections.push(this.av_connections[last]);
        this.full_av_hidden_nodes.push(this.av_hidden_nodes[last]);
        while (this.tick_record.length > this.record_size_limit) {
            this.tick_record.shift();
            this.pop_counts.shift();
            this.species_counts.shift();
            this.av_mut_rates.shift();
            this.av_cells.shift();
            this.av_cell_counts.shift();
            this.species_diet_counts.shift();
            this.population_diet_counts.shift();
            this.av_connections.shift();
            this.av_hidden_nodes.shift();
        }
    },

    /** Average enabled-connection count and hidden-node count across all
     *  living organisms with a NEAT-style genome. Organisms with the legacy
     *  Phase-1 brain (or no brain at all) are skipped, so this is a valid
     *  proxy for "topology growth since Phase 2 kicked in". */
    calcBrainAverages() {
        let n = 0, total_conns = 0, total_hidden = 0;
        for (const org of this.env.organisms) {
            const g = org.brain && org.brain.genome;
            if (!g) continue;
            total_conns  += g.numEnabledConnections();
            total_hidden += g.numHiddenNodes();
            n++;
        }
        this.av_connections.push(n > 0 ? total_conns  / n : 0);
        this.av_hidden_nodes.push(n > 0 ? total_hidden / n : 0);
    },

        calcDietSpecializationCounts() {
        const counts = {
            type0_only: 0,
            type1_only: 0,
            type2_only: 0,
            type3_only: 0,
            generalist: 0,
            none: 0
        };

        for (let s of Object.values(this.extant_species)) {
            const diets = Array.isArray(s.mouth_diets) ? s.mouth_diets : [];
            if (diets.length === 0) {
                counts.none++;
            } else if (diets.length > 1) {
                counts.generalist++;
            } else if (diets[0] === 0) {
                counts.type0_only++;
            } else if (diets[0] === 1) {
                counts.type1_only++;
            } else if (diets[0] === 2) {
                counts.type2_only++;
            } else if (diets[0] === 3) {
                counts.type3_only++;
            } else {
                counts.none++;
            }
        }
        return counts;
    },

    calcPopulationDietCounts() {
        const counts = {
            type0_only: 0,
            type1_only: 0,
            type2_only: 0,
            type3_only: 0,
            generalist: 0,
            none: 0
        };

        for (let s of Object.values(this.extant_species)) {
            const pop = s.population || 0;
            const diets = Array.isArray(s.mouth_diets) ? s.mouth_diets : [];
            if (diets.length === 0) {
                counts.none += pop;
            } else if (diets.length > 1) {
                counts.generalist += pop;
            } else if (diets[0] === 0) {
                counts.type0_only += pop;
            } else if (diets[0] === 1) {
                counts.type1_only += pop;
            } else if (diets[0] === 2) {
                counts.type2_only += pop;
            } else if (diets[0] === 3) {
                counts.type3_only += pop;
            } else {
                counts.none += pop;
            }
        }
        return counts;
    },

    calcCellCountAverages() {
        var total_org = 0;
        var cell_counts = {};
        for (let c of CellStates.living) {
            cell_counts[c.name] = 0;
        }
        var first=true;
        for (let s of Object.values(this.extant_species)) {
            if (!first && this.numExtantSpecies() > 10 && s.cumulative_pop < this.min_discard){
                continue;
            }
            for (let name in s.cell_counts) {
                cell_counts[name] += s.cell_counts[name] * s.population;
            }
            total_org += s.population;
            first=false;
        }
        if (total_org == 0) {
            this.av_cells.push(0);
            this.av_cell_counts.push(cell_counts);
            return;
        }

        var total_cells = 0;
        for (let c in cell_counts) {
            total_cells += cell_counts[c];
            cell_counts[c] /= total_org;
        }
        this.av_cells.push(total_cells / total_org);
        this.av_cell_counts.push(cell_counts);
    },

    getMostPopulousSpecies(){
        var max_pop = 0;
        var max_species = undefined;
        for (let s of Object.values(this.extant_species)) {
            if (s.population > max_pop) {
                max_pop = s.population;
                max_species = s;
            }
        }
        return max_species;
    },

    clear_record() {
        this.extant_species = [];
        this.extinct_species = [];
        this.setData();
    },

    serialize() {
        this.updateData();
        let record = SerializeHelper.copyNonObjects(this);
        // Full history from tick 0 — the canonical record_size-unbounded data.
        record.records = {
            tick_record:this.full_tick_record,
            pop_counts:this.full_pop_counts,
            species_counts:this.full_species_counts,
            av_mut_rates:this.full_av_mut_rates,
            av_cells:this.full_av_cells,
            av_cell_counts:this.full_av_cell_counts,
            species_diet_counts: this.full_species_diet_counts,
            population_diet_counts: this.full_population_diet_counts,
            av_connections:  this.full_av_connections,
            av_hidden_nodes: this.full_av_hidden_nodes,
        };
        // Sliding-window snapshot the in-browser charts were using, kept around
        // for any consumer that explicitly wants the last record_size_limit ticks.
        record.window_records = {
            tick_record:this.tick_record,
            pop_counts:this.pop_counts,
            species_counts:this.species_counts,
            av_mut_rates:this.av_mut_rates,
            av_cells:this.av_cells,
            av_cell_counts:this.av_cell_counts,
            species_diet_counts: this.species_diet_counts,
            population_diet_counts: this.population_diet_counts,
            av_connections:  this.av_connections,
            av_hidden_nodes: this.av_hidden_nodes,
        };
        let species = {};
        for (let s of Object.values(this.extant_species)) {
            species[s.name] = SerializeHelper.copyNonObjects(s);
            delete species[s.name].name;
            if (s.founder_brain) species[s.name].founder_brain = s.founder_brain;
        }
        record.species = species;
        return record;
    },

    // Returns founder brains ranked by cumulative population, best first.
    // Useful for identifying which starting weights produced stable lineages.
    exportFounderBrainsRanked: function() {
        const combined = Object.values(this.extant_species)
            .concat(Object.values(this.extinct_species))
            .filter(s => s.founder_brain)
            .sort((a, b) => b.cumulative_pop - a.cumulative_pop);
        return combined.map(s => ({
            species:        s.name,
            extinct:        !!s.extinct,
            start_tick:     s.start_tick,
            end_tick:       s.end_tick,
            cumulative_pop: s.cumulative_pop,
            mouth_diets:    s.mouth_diets,
            cell_counts:    s.cell_counts,
            founder_brain:  s.founder_brain,
        }));
    },

    loadRaw(record) {
        SerializeHelper.overwriteNonObjects(record, this);
        // `records` now holds full history (post-change). Mirror it into both the
        // sliding window and the full-history arrays so loading a freshly-saved
        // file works correctly even though the window will be re-shifted on the
        // next updateData() call.
        if (record.records) {
            for (let key in record.records) {
                this[key] = record.records[key];
                this['full_' + key] = (record.records[key] || []).slice();
            }
        }
        // Older saves wrote only sliding-window data into `records` and have no
        // full history. Newer saves include both for back-compat with downstream
        // tools — prefer the explicit window_records when present.
        if (record.window_records) {
            for (let key in record.window_records) {
                this[key] = record.window_records[key];
            }
        }
    },

    exportSpeciesDietCountsCSV() {
        let csv = 'tick,type0_only,type1_only,type2_only,type3_only,generalist,none\n';
        for (let i = 0; i < this.tick_record.length; i++) {
            const tick = this.tick_record[i];
            const dietCounts = this.species_diet_counts[i] || {};
            csv += `${tick},${dietCounts.type0_only || 0},${dietCounts.type1_only || 0},${dietCounts.type2_only || 0},${dietCounts.type3_only || 0},${dietCounts.generalist || 0},${dietCounts.none || 0}\n`;
        }
        return csv;
    },

    exportPopulationCountsCSV() {
        let csv = 'tick,population\n';
        for (let i = 0; i < this.tick_record.length; i++) {
            csv += `${this.tick_record[i]},${this.pop_counts[i] || 0}\n`;
        }
        return csv;
    },

    exportSpeciesCountsCSV() {
        let csv = 'tick,species\n';
        for (let i = 0; i < this.tick_record.length; i++) {
            csv += `${this.tick_record[i]},${this.species_counts[i] || 0}\n`;
        }
        return csv;
    },

    exportPopulationDietCountsCSV() {
        let csv = 'tick,type0_only,type1_only,type2_only,type3_only,generalist,none\n';
        for (let i = 0; i < this.tick_record.length; i++) {
            const tick = this.tick_record[i];
            const dietCounts = this.population_diet_counts[i] || {};
            csv += `${tick},${dietCounts.type0_only || 0},${dietCounts.type1_only || 0},${dietCounts.type2_only || 0},${dietCounts.type3_only || 0},${dietCounts.generalist || 0},${dietCounts.none || 0}\n`;
        }
        return csv;
    }

}

FossilRecord.init();

module.exports = FossilRecord;