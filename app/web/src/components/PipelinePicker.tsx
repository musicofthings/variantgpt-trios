import { Link } from "react-router-dom";

/** The three-pipeline chooser used on both the Home landing page and the
 *  dedicated "New case" selection screen. Each card routes into the Intake
 *  flow with the chosen mode seeded via `?mode=`. */
export function PipelinePicker() {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 16,
      }}
    >
      <PipelineCard
        title="Singleton"
        subtitle="Proband only"
        desc="One sample — the proband. Use when parental samples are unavailable. De novo cannot be confirmed; comp-het and AR-hom are still callable from genotype + AF. ACMG remains valid."
        mode="singleton"
        icon="◯"
      />
      <PipelineCard
        title="Duo"
        subtitle="Proband + 1 parent"
        desc="Two samples — proband and one parent. De novo can be claimed only at sites the present parent is confidently 0/0; trans-phasing for compound het is partial."
        mode="duo"
        icon="◐"
      />
      <PipelineCard
        title="Trio"
        subtitle="Proband + both parents"
        desc="Three samples — proband, father, mother. Full segregation: PS2 (de novo strong) and trans-phased compound het both available. The default for clinical pediatric workups."
        mode="trio"
        icon="●"
        recommended
      />
    </section>
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
      to={`/cases/new/intake?mode=${mode}`}
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
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>{subtitle}</div>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)", margin: 0 }}>{desc}</p>
      <div style={{ marginTop: 14, fontSize: 12, color: "var(--primary)", fontWeight: 500 }}>
        Start {title.toLowerCase()} →
      </div>
    </Link>
  );
}
