import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";

/** Report view — design spec §4.5. Print-grade preview matching the PDF that
 * /cases/:id/report (PRD §6.6) renders. Research-use, human-signed. */
export function Report() {
  return (
    <>
      <div className="topbar">
        <h1>Report</h1>
        <span className="pill mono">GRCh38</span>
        <span className="pill">Draft · awaiting signature</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button>Export TSV</button>
          <button>Export JSON</button>
          <button className="primary">Export PDF</button>
        </div>
      </div>

      <article
        className="card"
        style={{
          padding: 48,
          maxWidth: 880,
          margin: "0 auto",
          fontFamily: "var(--font-body)",
          lineHeight: 1.6,
        }}
      >
        <header style={{ borderBottom: "1px solid var(--border)", paddingBottom: 16, marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--ink-soft)", textTransform: "uppercase" }}>
            VariantGPT · Trio variant interpretation
          </div>
          <h2 style={{ marginTop: 4 }}>GIAB trio (HG002/3/4) — case demo-001</h2>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
            Build GRCh38 · Generated 2026-05-23 · Engine v0.1.0
          </div>
        </header>

        <Section title="Case summary">
          <DL items={[
            ["Proband", "HG002 (affected, sex unknown)"],
            ["Parents", "HG003 (father, unaffected) · HG004 (mother, unaffected)"],
            ["Consanguinity", "No"],
            ["Age of onset", "—"],
            ["Prior testing", "—"],
          ]} />
        </Section>

        <Section title="Phenotype (HPO)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <span className="hpo-chip confirmed">HP:0001250 · Seizure</span>
            <span className="hpo-chip confirmed">HP:0001263 · Global developmental delay</span>
          </div>
        </Section>

        <Section title="Prioritized findings">
          <table className="table" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Gene · variant</th>
                <th>Inheritance</th>
                <th>Tier</th>
                <th>Reclass</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">1</td>
                <td className="mono">TTN c.41329C&gt;T p.Arg13777*</td>
                <td>de novo</td>
                <td><TierChip tier="LP" /></td>
                <td>—</td>
              </tr>
              <tr className="reclass">
                <td className="num">2</td>
                <td className="mono">HBB c.20A&gt;T p.Glu7Val</td>
                <td>AR hom</td>
                <td><TierChip tier="VUS" /></td>
                <td><ReclassBadge from="VUS" to="LB" delta={-5} criteria={["PM2 retracted", "BS1"]} /></td>
              </tr>
            </tbody>
          </table>
          <p style={{ marginTop: 12, fontSize: 13 }}>
            <strong>TTN c.41329C&gt;T (p.Arg13777*)</strong> — predicted loss-of-function, confirmed
            de novo. Criteria: PVS1 (Strong), PS2 (Strong), PM2 (Supporting), PP3 (Supporting).
            Sum +11 → Likely Pathogenic.
          </p>
          <p style={{ marginTop: 8, fontSize: 13 }}>
            <strong>HBB c.20A&gt;T (p.Glu7Val)</strong> — present at AF 0.019 in IndiGenomes and 0.012
            in gnomAD-SAS, exceeding the BS1 threshold. PM2 is retracted; BS1 fires. Reclassification
            proposal VUS → Likely Benign (Δ −5) — <em>awaiting curator decision</em>.
          </p>
        </Section>

        <Section title="Reclassification decisions">
          <table className="table">
            <thead>
              <tr>
                <th>Variant</th>
                <th>Proposal</th>
                <th>Decision</th>
                <th>Curator</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">HBB c.20A&gt;T</td>
                <td>VUS → LB (Δ −5)</td>
                <td><em>Pending</em></td>
                <td>—</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </Section>

        <Section title="Methods & limitations">
          <p style={{ fontSize: 13 }}>
            VCFs were normalized with <code>bcftools norm</code> and lifted to GRCh38 where required.
            Joint genotypes were merged across the trio; QC included Mendelian error rate, sex
            check, and relatedness (KING-robust). Variants were annotated with VEP (MANE Select),
            ClinVar, gnomAD v4 (including SAS), IndiGenomes, GenomeAsia, and precomputed
            AlphaMissense / REVEL / CADD / SpliceAI scores. ACMG/AMP classification used the
            ClinGen SVI Bayesian point system. Variants called VUS were re-evaluated against
            South-Asian frequency baselines (PRD §4.6); reclassification proposals never
            auto-commit and require curator decision.
          </p>
          <p style={{ fontSize: 13, marginTop: 8 }}>
            Limitations: SNVs and small indels only; CNV/SV and mitochondrial heteroplasmy out of
            scope for v1. Liftover failures are flagged, not silently dropped.
          </p>
        </Section>

        <Section title="Version snapshot">
          <DL items={[
            ["Engine", "v0.1.0"],
            ["Reference", "GRCh38 / GENCODE 45 / MANE 1.3"],
            ["gnomAD", "v4.1 (genome + exome)"],
            ["IndiGenomes", "v1.1"],
            ["GenomeAsia", "100K pilot"],
            ["ClinVar", "2026-05-15 weekly"],
            ["Predictors", "AlphaMissense 2023.1 · REVEL 1.3 · CADD 1.7 · SpliceAI 1.3"],
            ["LLM", "claude-opus-4-7 via AI Gateway → OpenRouter (pinned, fallback disabled)"],
          ]} />
        </Section>

        <Section title="Signatory">
          <DL items={[
            ["Signed by", "—"],
            ["Date", "—"],
          ]} />
        </Section>

        <footer
          style={{
            marginTop: 32, paddingTop: 16,
            borderTop: "1px solid var(--border)",
            fontSize: 11, color: "var(--ink-soft)",
            letterSpacing: "0.04em",
          }}
        >
          RESEARCH USE ONLY. Not for diagnostic purposes. Reclassification proposals require a
          recorded human decision before they appear in a signed report (PRD §4.10).
        </footer>
      </article>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3 style={{ fontSize: 15, marginBottom: 8 }}>{title}</h3>
      {children}
    </section>
  );
}

function DL({ items }: { items: [string, string][] }) {
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        rowGap: 4,
        columnGap: 16,
        margin: 0,
        fontSize: 13,
      }}
    >
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: "var(--ink-soft)" }}>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
