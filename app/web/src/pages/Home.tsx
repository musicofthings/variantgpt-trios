import { Link } from "react-router-dom";
import { PipelinePicker } from "../components/PipelinePicker";

/** VariantGPT home / landing screen.
 *
 * Three pipeline modes are surfaced as the primary call-to-action:
 *   - Singleton: proband only (no parents). De novo cannot be confirmed;
 *     classification depends on AF + predictors + ClinVar.
 *   - Duo:       proband + one parent. De novo can be claimed only for
 *     variants the present parent is 0/0 at; trans-phasing for compound
 *     hets is half-resolved.
 *   - Trio:      proband + both parents. Full segregation analysis.
 *
 * All three modes route into the same Intake page, differentiated only by
 * a `?mode=` query parameter that seeds the default pedigree.
 *
 * The "Open existing case" tile sends the user to the cases list (the old
 * Dashboard, now mounted at /cases).
 */
export function Home() {
  return (
    <>
      <div className="topbar">
        <h1>VariantGPT</h1>
        <span className="pill mono">v0.1</span>
        <span className="pill">South-Asian-aware clinical variant interpretation</span>
      </div>

      <section style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 720, color: "var(--ink-soft)" }}>
          Pick an analysis pipeline to start a new case, or open an existing case from
          your queue. All three pipelines share the same ACMG/AMP classification engine,
          South-Asian allele-frequency reclassification (IndiGenomes / GenomeAsia /
          GenomeIndia), and HPO phenotype matching; they differ only in how segregation
          and de-novo evidence is interpreted.
        </p>
      </section>

      <div style={{ marginBottom: 32 }}>
        <PipelinePicker />
      </div>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        <Link
          to="/cases"
          className="card"
          style={{
            padding: 20,
            display: "block",
            textDecoration: "none",
            color: "var(--ink)",
            borderColor: "var(--rule)",
          }}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>↗</div>
          <h3 style={{ marginBottom: 4 }}>Open existing case</h3>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Browse, re-run, or clean up cases already in your queue.
          </p>
        </Link>

        <Link
          to="/tracks"
          className="card"
          style={{
            padding: 20,
            display: "block",
            textDecoration: "none",
            color: "var(--ink)",
            borderColor: "var(--rule)",
          }}
        >
          <div style={{ fontSize: 22, marginBottom: 6 }}>⚙</div>
          <h3 style={{ marginBottom: 4 }}>Tracks & settings</h3>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Population databases, predictor versions, ACMG threshold overrides.
          </p>
        </Link>
      </section>
    </>
  );
}
