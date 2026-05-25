import type { Predictors } from "../types";

/** Predictor gauges — design spec §4.4. Compact, calibrated-threshold marker per predictor.
 * Thresholds reflect ClinGen-calibrated PP3/BP4 cutoffs (PRD §7); curator can override globally. */
type Spec = {
  key: keyof Predictors;
  label: string;
  /** [min, max] for the gauge range. */
  range: [number, number];
  /** Calibrated supporting-pathogenic threshold marker. */
  threshold: number;
  /** Higher values = more pathogenic by convention. */
  higherIsPathogenic: boolean;
};

const SPECS: Spec[] = [
  { key: "alphamissense", label: "AlphaMissense", range: [0, 1], threshold: 0.564, higherIsPathogenic: true },
  { key: "revel",         label: "REVEL",         range: [0, 1], threshold: 0.644, higherIsPathogenic: true },
  { key: "cadd",          label: "CADD",          range: [0, 40], threshold: 25.3, higherIsPathogenic: true },
  { key: "spliceai",      label: "SpliceAI",      range: [0, 1], threshold: 0.2,   higherIsPathogenic: true },
];

export function PredictorGauges({ predictors }: { predictors: Predictors }) {
  return (
    <ul className="gauges">
      {SPECS.map((s) => {
        const v = predictors[s.key];
        if (v == null) {
          return (
            <li key={s.key} className="gauge gauge-empty">
              <div className="gauge-label">{s.label}</div>
              <div className="gauge-value mono">—</div>
            </li>
          );
        }
        const [lo, hi] = s.range;
        const pct = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
        const thrPct = ((s.threshold - lo) / (hi - lo)) * 100;
        const over = s.higherIsPathogenic ? v >= s.threshold : v <= s.threshold;
        return (
          <li key={s.key} className={`gauge${over ? " over" : ""}`}>
            <div className="gauge-label">{s.label}</div>
            <div className="gauge-track">
              <span className="gauge-fill" style={{ width: `${pct}%` }} />
              <span className="gauge-threshold" style={{ left: `${thrPct}%` }} aria-hidden />
            </div>
            <div className="gauge-value mono">{v.toFixed(s.key === "cadd" ? 1 : 3)}</div>
          </li>
        );
      })}
    </ul>
  );
}
