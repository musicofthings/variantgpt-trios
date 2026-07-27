import { useState } from "react";
import { DEFAULT_THRESHOLD, GENE_THRESHOLDS, POPULATION_TRACKS, PREDICTORS } from "../tracksData";

/** Tracks & Settings — read-only reference for what the engine currently runs
 *  with: population AF sources used for South-Asian reclassification,
 *  in-silico predictor conventions/thresholds, and gene-specific ACMG
 *  BA1/BS1 frequency cutoffs. No editing here — thresholds.py has no
 *  persistence layer for overrides today, so this surfaces the values in
 *  effect rather than letting you change them. */
export function Tracks() {
  const [geneQuery, setGeneQuery] = useState("");
  const filteredGenes = GENE_THRESHOLDS.filter((g) =>
    g.gene.toLowerCase().includes(geneQuery.trim().toLowerCase())
  );

  return (
    <>
      <div className="topbar">
        <h1>Tracks &amp; Settings</h1>
        <span className="pill">{POPULATION_TRACKS.length} population sources</span>
        <span className="pill">{GENE_THRESHOLDS.length} gene-specific thresholds</span>
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Population AF tracks</h2>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12, maxWidth: 720 }}>
          South-Asian reclassification runs against these sources specifically —
          never gnomAD-SAS (deliberately excluded, see below). Reclassification
          runs bidirectionally on every tier, not just VUS, and every tier
          change requires a recorded curator decision before it takes effect.
        </p>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Source</th>
                <th>Role</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {POPULATION_TRACKS.map((t) => (
                <tr key={t.name}>
                  <td style={{ fontWeight: 500 }}>{t.name}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{t.role}</td>
                  <td>
                    <span className="pill" style={{ fontSize: 11 }}>{t.status}</span>
                  </td>
                  <td style={{ color: "var(--ink-soft)" }}>{t.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ marginBottom: 8 }}>Predictor scores</h2>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12, maxWidth: 720 }}>
          All optional per-variant, sourced from dbNSFP via myvariant.info — a
          missing score simply doesn't fire its PP3/BP4 criterion. No version
          pinning: myvariant.info always serves its current dbNSFP build.
        </p>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Predictor</th>
                <th>Direction</th>
                <th>Thresholds</th>
              </tr>
            </thead>
            <tbody>
              {PREDICTORS.map((p) => (
                <tr key={p.name}>
                  <td style={{ fontWeight: 500 }}>{p.name}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{p.direction}</td>
                  <td className="mono">{p.thresholds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: 8 }}>ACMG frequency thresholds (BA1 / BS1)</h2>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 12, maxWidth: 720 }}>
          Population allele-frequency cutoffs for the stand-alone-benign (BA1)
          and strong-benign (BS1) criteria. Genes below have a published
          ClinGen VCEP threshold; every other gene falls back to the SVI
          default —{" "}
          <span className="mono">
            BA1 {DEFAULT_THRESHOLD.ba1} · BS1 {DEFAULT_THRESHOLD.bs1} · PM2 supporting {DEFAULT_THRESHOLD.pm2Supporting}
          </span>{" "}
          ({DEFAULT_THRESHOLD.source}).
        </p>
        <input
          value={geneQuery}
          onChange={(e) => setGeneQuery(e.target.value)}
          placeholder="Filter by gene…"
          style={{ width: "100%", maxWidth: 280, padding: "8px 10px", marginBottom: 12 }}
          aria-label="Filter gene thresholds"
        />
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Gene</th>
                <th className="num">BA1</th>
                <th className="num">BS1</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {filteredGenes.map((g) => (
                <tr key={g.gene}>
                  <td className="mono" style={{ fontWeight: 500 }}>{g.gene}</td>
                  <td className="num">{g.ba1}</td>
                  <td className="num">{g.bs1}</td>
                  <td style={{ color: "var(--ink-soft)" }}>{g.source}</td>
                </tr>
              ))}
              {filteredGenes.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ color: "var(--ink-soft)", textAlign: "center", padding: 16 }}>
                    No gene matches “{geneQuery}” — it uses the SVI default above.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
