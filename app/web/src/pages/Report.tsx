import { useMemo } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { useDemoCase } from "../caseData";
import type { VariantRow } from "../types";

/** Report view — design spec §4.5. Print-grade preview that renders the
 *  selected variants from the workbench. Selected variant IDs come in via
 *  the `variants` query parameter (comma-separated). */
export function Report() {
  const { caseId } = useParams<{ caseId: string }>();
  const [search] = useSearchParams();
  const { data, loading, error } = useDemoCase(caseId);

  const selectedIds = useMemo(() => {
    const raw = search.get("variants") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [search]);

  // The variants the curator selected on the workbench. If selection is
  // empty (someone hit the URL directly), fall back to all P + LP variants
  // — almost always what the user actually wants for a report.
  const reportVariants: VariantRow[] = useMemo(() => {
    if (!data) return [];
    if (selectedIds.size > 0) {
      return data.variants.filter((v) => selectedIds.has(v.id));
    }
    return data.variants.filter((v) => v.baseline_tier === "P" || v.baseline_tier === "LP");
  }, [data, selectedIds]);

  const reclassDecisions = useMemo(
    () => reportVariants.filter((v) => v.reclass != null),
    [reportVariants],
  );

  if (loading) {
    return <div className="card">Loading case…</div>;
  }
  if (error || !data) {
    return (
      <div className="card">
        <p>Could not load case data: {error}</p>
        <Link to={`/cases/${caseId}`}>Back to workbench</Link>
      </div>
    );
  }

  const pedigree = data.caseRow;
  const today = new Date().toISOString().slice(0, 10);

  function exportTSV() {
    const rows = [
      ["Gene", "HGVSc", "HGVSp", "Consequence", "Inheritance", "AF_global", "AF_SAS", "AF_Indi", "Tier", "Reclass"],
      ...reportVariants.map((v) => [
        v.gene ?? "", v.hgvs_c ?? "", v.hgvs_p ?? "", v.consequence ?? "",
        v.inheritance_models.join("|"),
        v.af_global?.toString() ?? "",
        v.af_sas?.toString() ?? "",
        v.af_indi?.toString() ?? "",
        v.baseline_tier,
        v.reclass ? `${v.reclass.from}->${v.reclass.to} (delta ${v.reclass.delta})` : "",
      ]),
    ];
    downloadFile(
      `${caseId}-report.tsv`,
      rows.map((r) => r.map((c) => c.replace(/\t/g, " ")).join("\t")).join("\n"),
      "text/tab-separated-values",
    );
  }

  function exportJSON() {
    const payload = {
      case_id: caseId,
      generated_at: new Date().toISOString(),
      proband: pedigree.proband,
      variants: reportVariants,
    };
    downloadFile(
      `${caseId}-report.json`,
      JSON.stringify(payload, null, 2),
      "application/json",
    );
  }

  return (
    <>
      <div className="topbar">
        <h1>Report</h1>
        <span className="pill mono">GRCh38</span>
        <span className="pill">
          {reportVariants.length} variant{reportVariants.length === 1 ? "" : "s"}
          {selectedIds.size === 0 ? " · auto-selected P/LP" : " · selected"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Link to={`/cases/${caseId}`}><button>← Back to workbench</button></Link>
          <button onClick={exportTSV}>Export TSV</button>
          <button onClick={exportJSON}>Export JSON</button>
          <button className="primary" onClick={() => window.print()}>Print / PDF</button>
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
          <h2 style={{ marginTop: 4 }}>{pedigree.name}</h2>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, marginTop: 4 }}>
            Case {caseId} · Build GRCh38 · Generated {today}
          </div>
        </header>

        <Section title="Case summary">
          <DL items={[
            ["Proband", pedigree.proband ?? "—"],
            ["Variants surveyed", `${data.variants.length}`],
            ["VUS in case", `${pedigree.vus_count ?? "—"}`],
            ["Reclassifications proposed", `${pedigree.reclass_count ?? "—"}`],
            ["Variants in this report", `${reportVariants.length}`],
          ]} />
        </Section>

        <Section title="Selected findings">
          {reportVariants.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              No variants selected. Go back to the workbench, check the boxes for variants you
              want in the report, then click <strong>Generate report</strong>.
            </p>
          ) : (
            <table className="table" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Gene · variant</th>
                  <th>Inheritance</th>
                  <th className="num">AF SAS</th>
                  <th>Tier</th>
                  <th>Reclass</th>
                </tr>
              </thead>
              <tbody>
                {reportVariants.map((v, i) => (
                  <tr key={v.id} className={v.reclass ? "reclass" : undefined}>
                    <td className="num">{i + 1}</td>
                    <td className="mono">
                      <strong>{v.gene}</strong> {v.hgvs_c}
                      {v.hgvs_p ? <span style={{ color: "var(--ink-soft)" }}> {v.hgvs_p}</span> : null}
                    </td>
                    <td>{v.inheritance_models.join(", ") || "—"}</td>
                    <td className="num">{fmt(v.af_sas)}</td>
                    <td><TierChip tier={v.baseline_tier} /></td>
                    <td>{v.reclass ? <ReclassBadge {...v.reclass} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {reclassDecisions.length > 0 ? (
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
                {reclassDecisions.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.gene} {v.hgvs_c}</td>
                    <td>{v.reclass!.from} → {v.reclass!.to} (Δ {v.reclass!.delta})</td>
                    <td><em>Pending</em></td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}

        <Section title="Methods & limitations">
          <p style={{ fontSize: 13 }}>
            Per-sample VCFs were preprocessed (FILTER pass, GQ ≥ 20, DP ≥ 10, AB 0.20-0.80,
            multi-allelic split, allele trimming) and merged into a trio joint matrix.
            Inheritance models (de novo / AR hom / compound het / AD inherited / X-linked /
            mitochondrial) were assigned with GATK-style QC gating. Variants were filtered
            to the proband-carrier set, then to rare (AF &lt; 1% in gnomAD v4 exome+genome),
            then annotated via Ensembl VEP REST + myvariant.info (ClinVar, dbNSFP). ACMG/AMP
            classification used the ClinGen SVI Bayesian point system. VUS were re-evaluated
            against South-Asian frequency baselines (gnomAD-SAS, IndiGenomes); reclassification
            proposals never auto-commit and require curator decision.
          </p>
          <p style={{ fontSize: 13, marginTop: 8 }}>
            Limitations: SNVs and small indels only; CNV/SV and mitochondrial heteroplasmy
            out of scope. Liftover (37 → 38) requires CrossMap and is not yet wired.
          </p>
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
          RESEARCH USE ONLY. Not for diagnostic purposes. Reclassification proposals
          require a recorded human decision before they appear in a signed report.
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

function fmt(v?: number | null): string {
  if (v == null) return "—";
  if (v === 0) return "0";
  if (v < 1e-4) return v.toExponential(1);
  return v.toFixed(4);
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
