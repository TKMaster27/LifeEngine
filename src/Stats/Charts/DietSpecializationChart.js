const FossilRecord = require("../FossilRecord");
const ChartController = require("./ChartController");

class DietSpecializationChart extends ChartController {
    constructor() {
        super(
            "Diet Specialization",
            "Number of Extant Species",
            "Species counted by mouth diet capability: specialists vs generalists."
        );
    }

    setData() {
        this.clear();
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#2F7AB7",
            showInLegend: true,
            legendText: "Type 0 specialists",
            dataPoints: []
        });
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#e21bf8",
            showInLegend: true,
            legendText: "Type 1 specialists",
            dataPoints: []
        });
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#ff0080",
            showInLegend: true,
            legendText: "Type 1 specialists",
            dataPoints: []
        });
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#fac800",
            showInLegend: true,
            legendText: "Type 1 specialists",
            dataPoints: []
        });
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#15DE59",
            showInLegend: true,
            legendText: "Generalists",
            dataPoints: []
        });
        this.data.push({
            type: "line",
            markerType: "none",
            color: "#888888",
            showInLegend: true,
            legendText: "No diet/mouth",
            dataPoints: []
        });
        this.addAllDataPoints();
    }

    addDataPoint(i) {
        const t = FossilRecord.tick_record[i];
        const d = FossilRecord.species_diet_counts[i] || { type0_only: 0, type1_only: 0, generalist: 0, none: 0 };
        this.data[0].dataPoints.push({ x: t, y: d.type0_only });
        this.data[1].dataPoints.push({ x: t, y: d.type1_only });
        this.data[2].dataPoints.push({ x: t, y: d.type2_only });
        this.data[3].dataPoints.push({ x: t, y: d.type3_only });
        this.data[4].dataPoints.push({ x: t, y: d.generalist });
        this.data[5].dataPoints.push({ x: t, y: d.none });
    }
}

module.exports = DietSpecializationChart;