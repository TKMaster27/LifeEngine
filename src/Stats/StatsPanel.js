const PopulationChart = require("./Charts/PopulationChart");
const SpeciesChart = require("./Charts/SpeciesChart");
const MutationChart = require("./Charts/MutationChart");
const CellsChart = require("./Charts/CellsChart");
const DietSpecializationChart = require("./Charts/DietSpecializationChart");
const PopulationDietSpecializationChart = require("./Charts/PopulationDietSpecializationChart");
const FossilRecord = require("./FossilRecord");


const ChartSelections = [PopulationChart, SpeciesChart, CellsChart, MutationChart, DietSpecializationChart, PopulationDietSpecializationChart];

class StatsPanel {
    constructor(env) {
        this.defineControls();
        this.chart_selection = 0;
        this.setChart();
        this.env = env;
        this.last_reset_count=env.reset_count;
    }

    setChart(selection=this.chart_selection) {
        this.chart_controller = new ChartSelections[selection]();
        this.chart_controller.setData();
        this.chart_controller.render();
        this.updateDownloadButton();
    }

    startAutoRender() {
        this.setChart();
        this.render_loop = setInterval(function(){this.updateChart();}.bind(this), 1000);
    }

    stopAutoRender() {
        clearInterval(this.render_loop);
    }

    defineControls() {
        $('#chart-option').change ( function() {
            this.chart_selection = $("#chart-option")[0].selectedIndex;
            this.setChart();
            this.updateDownloadButton();
        }.bind(this));

        $('#export-chart-csv').click(() => {
            const action = this.getDownloadAction();
            if (!action) {
                return;
            }
            const { csv, filename } = action;
            this.downloadCSV(csv, filename);
        });
    }

    getDownloadAction() {
        switch (this.chart_selection) {
            case 0:
                return {
                    csv: FossilRecord.exportPopulationCountsCSV(),
                    filename: 'population-counts.csv'
                };
            case 1:
                return {
                    csv: FossilRecord.exportSpeciesCountsCSV(),
                    filename: 'species-counts.csv'
                };
            case 4:
                return {
                    csv: FossilRecord.exportSpeciesDietCountsCSV(),
                    filename: 'species-diet-counts.csv'
                };
            case 5:
                return {
                    csv: FossilRecord.exportPopulationDietCountsCSV(),
                    filename: 'population-diet-counts.csv'
                };
            default:
                return null;
        }
    }

    updateDownloadButton() {
        const action = this.getDownloadAction();
        if (!action) {
            $('#export-chart-csv').hide();
            return;
        }

        $('#export-chart-csv')
            .show()
            .text(`Download ${action.filename.replace('.csv', '').replace(/-/g, ' ')}`);
    }

    downloadCSV(csv, filename) {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.setAttribute('href', URL.createObjectURL(blob));
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    updateChart() {
        if (this.last_reset_count < this.env.reset_count){
            this.reset()
        }
        this.last_reset_count = this.env.reset_count;
        this.chart_controller.updateData();
        this.chart_controller.render();
        this.updateDownloadButton();
    }

    updateDetails() {
        var org_count = this.env.organisms.length;
        $('#org-count').text("Total Population: " + org_count);
        $('#species-count').text("Number of Species: " + FossilRecord.numExtantSpecies());
        let top_species = FossilRecord.getMostPopulousSpecies();
        if (top_species)
            $('#top-species').text("Most Populous Species: \"" + top_species.name + "\" (" + top_species.population + " organisms)");
        else    
            $('#top-species').text("Most Populous Species: None");
        $('#largest-org').text("Largest Organism Ever: " + this.env.largest_cell_count + " cells");
        $('#avg-mut').text("Average Mutation Rate: " + Math.round(this.env.averageMutability() * 100) / 100);
    }

    reset() {
        this.setChart();
        this.updateDownloadButton();
    }
    
}

module.exports = StatsPanel;