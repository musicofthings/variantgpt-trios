import { Link } from "react-router-dom";

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

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
          marginBottom: 32,
        }}
      >
        <PipelineCard
          title="Singleton"
          subtitle="Proband only"
          desc="One VCF — the proband. Use when parental samples are unavailable. De novo cannot be confirmed; comp-het and AR-hom are still callable from genotype + AF. ACMG remains valid."
          mode="singleton"
          icon="◯"
        />
        <PipelineCard
          title="Duo"
          subtitle="Proband + 1 parent"
          desc="Two VCFs — proband and one parent. De novo can be claimed only at sites the present parent is confidently 0/0; trans-phasing for compound het is partial. Best when one parent's sample is missing."
          mode="duo"
          icon="◐"
          recommended={false}
        />
        <PipelineCard
          title="Trio"
          subtitle="Proband + both parents"
          desc="Three VCFs — proband, father, mother. Full segregation: PS2 (de novo strong) and trans-phased compound het both available. The default for clinical pediatric workups."
          mode="trio"
          icon="●"
          recommended
        />
      </section>

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

function PipelineCard({
  title, subtitle, desc, mode, icon, recommended,
}: {
  title: string;
  subtitle: string;
  desc: string;
  mode: "singleton" | "duo" | "trio";
  icon: string;
  recommended?: boolean;
}) {
  return (
    <Link
      to={`/cases/new?mode=${mode}`}
      className="card"
      style={{
        padding: 20,
        display: "block",
        textDecoration: "none",
        color: "var(--ink)",
        position: "relative",
        borderColor: recommended ? "var(--primary)" : "var(--rule)",
        background: recommended ? "var(--primary-soft)" : "var(--surface)",
      }}
    >
      {recommended ? (
        <span
          style={{
            position: "absolute",
            top: 12, right: 12,
            fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
            background: "var(--primary)", color: "#fff",
            padding: "2px 8px", borderRadius: 999,
          }}
        >
          Recommended
        </span>
      ) : null}
      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
      <h3 style={{ marginBottom: 2 }}>{title}</h3>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>
        {subtitle}
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: 0 }}>
        {desc}
      </p>
      <div
        style={{
          marginTop: 14,
          fontSize: 12,
          color: recommended ? "var(--primary)" : "var(--primary)",
          fontWeight: 500,
        }}
      >
        Start {title.toLowerCase()} →
      </div>
    </Link>
  );
}
