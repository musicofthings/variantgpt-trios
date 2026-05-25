import type { PopulationAF, PopulationSource } from "../types";

/** Population frequency comparison — design spec §4.4.
 * Minimal horizontal lollipop with the BA1/BS1 threshold line marked, so the curator
 * SEES why a South Asian baseline changed the call. */
const LABELS: Record<PopulationSource, string> = {
  gnomad_global: "gnomAD global",
  gnomad_sas: "gnomAD SAS",
  indigenomes: "IndiGenomes",
  genomeasia: "GenomeAsia",
  genomeindia: "GenomeIndia",
};

const ORDER: PopulationSource[] = [
  "gnomad_global", "gnomad_sas", "indigenomes", "genomeasia", "genomeindia",
];

export function PopulationFreqPanel({
  populations,
  threshold = 0.01,
}: { populations: PopulationAF[]; threshold?: number }) {
  const byKey = new Map(populations.map((p) => [p.source, p]));
  const rows = ORDER.map((s) => byKey.get(s)).filter(Boolean) as PopulationAF[];
  const max = Math.max(threshold * 2, ...rows.map((r) => r.af ?? 0));

  return (
    <div className="popfreq">
      <div className="popfreq-axis" aria-hidden>
        <span>0</span>
        <span className="popfreq-threshold-label">
          BA1/BS1 {threshold}
        </span>
        <span>{max.toExponential(0)}</span>
      </div>
      <ul className="popfreq-list">
        {rows.map((r) => {
          const af = r.af ?? 0;
          const pct = max > 0 ? Math.min(100, (af / max) * 100) : 0;
          const thrPct = max > 0 ? Math.min(100, (threshold / max) * 100) : 0;
          const overThreshold = af >= threshold;
          return (
            <li key={r.source} className="popfreq-row">
              <span className="popfreq-label">{LABELS[r.source]}</span>
              <div className="popfreq-track">
                <span
                  className="popfreq-threshold"
                  style={{ left: `${thrPct}%` }}
                  aria-hidden
                />
                <span
                  className={`popfreq-bar${overThreshold ? " over" : ""}`}
                  style={{ width: `${pct}%` }}
                />
                <span className="popfreq-dot" style={{ left: `${pct}%` }} aria-hidden />
              </div>
              <span className="popfreq-value mono">
                {r.af == null ? "—" : af === 0 ? "0" : af < 1e-4 ? af.toExponential(1) : af.toFixed(4)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
