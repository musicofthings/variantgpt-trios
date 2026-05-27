import { useMemo } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { EvidenceLedger } from "../components/EvidenceLedger";
import { PopulationFreqPanel } from "../components/PopulationFreqPanel";
import { PredictorGauges } from "../components/PredictorGauges";
import { useDemoCase } from "../caseData";
import type { InheritanceModel, VariantRow } from "../types";

/** Clinical report — print-ready, paginated layout.
 *  - Page 1: cover + case summary + selected-findings table
 *  - Pages 2…N: one full clinical detail page per selected variant (same
 *               fields as the workbench's Clinical Card, plus phenotype
 *               relevance prose, evidence ledger, population AF, predictors)
 *
 *  `@media print` rules in global.css strip the app shell (sidebar/topbar/
 *  buttons), flatten cards, and force page breaks at .report-page so each
 *  variant lands on its own physical page.
 */
export function Report() {
  const { caseId } = useParams<{ caseId: string }>();
  const [search] = useSearchParams();
  const { data, loading, error } = useDemoCase(caseId);

  const selectedIds = useMemo(() => {
    const raw = search.get("variants") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [search]);

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

  if (loading) return <div className="card">Loading case…</div>;
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
      {/* Topbar — hidden on print via .no-print on global @media print rules.
          (The .topbar class itself is also hidden in print.) */}
      <div className="topbar no-print">
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
        className="card report"
        style={{
          padding: 48,
          maxWidth: 880,
          margin: "0 auto",
          fontFamily: "var(--font-body)",
          lineHeight: 1.6,
        }}
      >
        {/* ── PAGE 1 — Cover + summary ───────────────────────────────── */}
        <section className="report-page">
          <header style={{ borderBottom: "1px solid var(--border)", paddingBottom: 16, marginBottom: 24 }}>
            <div style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--ink-soft)", textTransform: "uppercase" }}>
              VariantGPT · Clinical Trio Variant Interpretation Report
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
                No variants selected. Return to the workbench, check the boxes for variants you
                want in the report, then click <strong>Generate report</strong>.
              </p>
            ) : (
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Gene · variant</th>
                    <th>Inheritance</th>
                    <th className="num">AF Indi</th>
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
                      <td>{v.inheritance_models.map(humanizeModel).join(", ") || "—"}</td>
                      <td className="num">{fmt(v.af_indi)}</td>
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
            <p style={{ fontSize: 12 }}>
              Per-sample VCFs were preprocessed (FILTER pass, GQ ≥ 20, DP ≥ 10, AB 0.20–0.80,
              multi-allelic split, allele trimming) and merged into a trio joint matrix.
              Inheritance models were assigned with GATK-style QC gating. Variants were
              filtered to the proband-carrier set, then to rare (AF &lt; 1% in gnomAD v4),
              then annotated via Ensembl VEP REST + myvariant.info (ClinVar, dbNSFP) and
              IndiGenomes for South-Asian allele frequencies. ACMG/AMP classification used
              the ClinGen SVI Bayesian point system. VUS were re-evaluated against Indian
              cohort baselines (IndiGenomes, GenomeAsia, GenomeIndia); reclassification
              proposals never auto-commit and require curator decision. Gene–phenotype
              relevance is annotated from the HPO consortium <em>genes_to_phenotype</em>
              catalog (matching case HPO terms against each variant's gene).
            </p>
            <p style={{ fontSize: 12, marginTop: 8 }}>
              <strong>Limitations:</strong> SNVs and small indels only; CNV/SV and
              mitochondrial heteroplasmy are out of scope. Liftover (GRCh37 → 38) requires
              CrossMap and is not yet wired. Compound-het calling depends on parental
              phasing — variants on the same haplotype may be over-called.
            </p>
          </Section>

          <Section title="Signatory">
            <DL items={[
              ["Signed by", "—"],
              ["Date", "—"],
            ]} />
          </Section>
        </section>

        {/* ── PAGES 2…N — One per variant ─────────────────────────────── */}
        {reportVariants.map((v, i) => (
          <VariantDetailPage key={v.id} v={v} index={i + 1} total={reportVariants.length} caseId={caseId!} />
        ))}

        <footer
          className="report-page"
          style={{
            marginTop: 32, paddingTop: 16,
            borderTop: "1px solid var(--border)",
            fontSize: 11, color: "var(--ink-soft)",
            letterSpacing: "0.04em",
          }}
        >
          <strong>RESEARCH USE ONLY.</strong> Not for diagnostic purposes. Reclassification
          proposals require a recorded human decision before they appear in a signed
          report. Generated by VariantGPT · {today} · Case {caseId}.
        </footer>
      </article>
    </>
  );
}

/** Per-variant detail page — same fields as the workbench's Clinical Card,
 *  plus phenotype relevance + evidence ledger + population AF + predictors.
 *  Wrapped in a .report-page so @media print forces it to a fresh sheet. */
function VariantDetailPage({ v, index, total, caseId }: {
  v: VariantRow;
  index: number;
  total: number;
  caseId: string;
}) {
  const STRENGTH_TOKEN: Record<string, string> = {
    VeryStrong: "_VS", Strong: "_S", Moderate: "_M", Supporting: "_Sup", StandAlone: "_BA",
  };
  const fired = (v.evidence ?? []).filter((e) => e.fired);
  const firedTokens = fired
    .map((e) => `${e.criterion}${e.strength ? STRENGTH_TOKEN[e.strength] ?? "" : ""}`)
    .join(", ");

  const omimUrl = v.omim_id ? `https://www.omim.org/entry/${v.omim_id}` : null;
  const clinvarUrl = v.clinvar?.variation_id
    ? `https://www.ncbi.nlm.nih.gov/clinvar/variation/${encodeURIComponent(v.clinvar.variation_id.replace(/^VCV0*/, ""))}/`
    : null;

  return (
    <section className="report-page" style={{ marginTop: 32 }}>
      <header style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--ink-soft)", textTransform: "uppercase" }}>
          Variant {index} of {total} · Case {caseId}
        </div>
        <h2 className="mono" style={{ marginTop: 4, fontSize: 20 }}>
          {v.gene} · {v.hgvs_c}
          {v.hgvs_p ? <span style={{ color: "var(--ink-soft)", marginLeft: 8 }}>{v.hgvs_p}</span> : null}
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <TierChip tier={v.baseline_tier} />
          {v.reclass ? <ReclassBadge {...v.reclass} /> : null}
          <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>{v.consequence}</span>
        </div>
      </header>

      {/* Clinical variant summary — identical fields to the workbench drawer */}
      <Section title="Clinical variant summary">
        <table style={{ width: "100%", fontSize: 12, lineHeight: 1.5, borderCollapse: "collapse" }} className="keep-together">
          <tbody>
            <RRow label="Gene" value={v.gene} />
            <RRow label="Transcript" value={v.transcript} mono />
            <RRow label="Location" value={v.exon ? `Exon ${v.exon}` : null} />
            <RRow label="Variant (HGVS)" value={
              <>
                <span className="mono">{v.hgvs_c}</span>
                {v.hgvs_p ? <span className="mono" style={{ color: "var(--ink-soft)" }}> ({v.hgvs_p})</span> : null}
              </>
            } />
            <RRow label="Genomic" value={v.genomic_hgvs} mono />
            <RRow label="Consequence" value={v.consequence} />
            <RRow label="Inheritance" value={
              v.inheritance_models.length
                ? <>
                    {v.inheritance_models.map(humanizeModel).join(", ")}
                    {v.inheritance_confidence ? (
                      <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>
                        {" "}· {v.inheritance_confidence} confidence
                      </span>
                    ) : null}
                  </>
                : null
            } />
            <RRow label="OMIM gene" value={
              omimUrl ? <a href={omimUrl}>{v.omim_id}</a> : null
            } />
            <RRow label="HPO matches" value={
              v.hpo_matches && v.hpo_matches.length > 0
                ? <span className="mono" style={{ fontSize: 11 }}>{v.hpo_matches.join(", ")}</span>
                : null
            } />
            {v.clinvar ? (
              <RRow label="ClinVar" value={
                <>
                  {clinvarUrl ? <a href={clinvarUrl} className="mono">{v.clinvar.variation_id}</a> : <span className="mono">{v.clinvar.variation_id}</span>}
                  {v.clinvar.clinical_significance ? <> · <strong>{v.clinvar.clinical_significance}</strong></> : null}
                  {v.clinvar.review_stars != null ? (
                    <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>
                      {" "}({v.clinvar.review_stars}★ {v.clinvar.review_status})
                    </span>
                  ) : null}
                  {v.clinvar.conditions && v.clinvar.conditions.length > 0 ? (
                    <div style={{ marginTop: 2, fontSize: 11, color: "var(--ink-soft)" }}>
                      {v.clinvar.conditions.slice(0, 3).join(" · ")}
                    </div>
                  ) : null}
                </>
              } />
            ) : null}
            <RRow label="ACMG fired" value={firedTokens ? <span className="mono" style={{ fontSize: 11 }}>{firedTokens}</span> : null} />
            <RRow label="Classification" value={
              <>
                <TierChip tier={v.baseline_tier} />
                {v.reclass ? <span style={{ marginLeft: 8 }}><ReclassBadge {...v.reclass} /></span> : null}
              </>
            } />
          </tbody>
        </table>
      </Section>

      {/* Phenotype relevance prose — driven by hpo_matches. Only render when
          the variant has at least one HPO overlap with the case's HPO list. */}
      {v.hpo_matches && v.hpo_matches.length > 0 ? (
        <Section title="Phenotype relevance">
          <p style={{ fontSize: 12 }}>
            <strong>{v.gene}</strong> is associated with{" "}
            <strong>{v.hpo_matches.length}</strong>{" "}
            of the case's recorded HPO phenotypes (
            <span className="mono" style={{ fontSize: 11 }}>{v.hpo_matches.join(", ")}</span>
            ) per the HPO consortium <em>genes_to_phenotype</em> catalog. Phenotype overlap
            does not by itself establish causation but is a strong prioritization signal
            in trio interpretation: variants in genes whose disease spectrum matches the
            proband's clinical phenotype are more likely to be the molecular diagnosis than
            phenotype-discordant findings of comparable ACMG strength.
          </p>
        </Section>
      ) : null}

      {/* Family genotype calls — zygosity / depth / AB / GQ per member. */}
      {v.calls && v.calls.length > 0 ? (
        <Section title="Family genotype calls">
          <table className="table keep-together" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Member</th>
                <th>Zygosity</th>
                <th className="num">Depth</th>
                <th className="num">Allele balance</th>
                <th className="num">GQ</th>
              </tr>
            </thead>
            <tbody>
              {v.calls.map((c) => (
                <tr key={c.member_id}>
                  <td>{c.role}</td>
                  <td>{humanizeZyg(c.zygosity)}</td>
                  <td className="num">{c.depth != null ? `${c.depth}x` : "—"}</td>
                  <td className="num">{c.allele_balance != null ? `${(c.allele_balance * 100).toFixed(1)}%` : "—"}</td>
                  <td className="num">{c.gq ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {v.evidence && v.evidence.length > 0 ? (
        <Section title="ACMG evidence ledger">
          <div className="keep-together">
            <EvidenceLedger rows={v.evidence} />
          </div>
        </Section>
      ) : null}

      {v.populations && v.populations.length > 0 ? (
        <Section title="Population allele frequencies">
          <div className="keep-together">
            <PopulationFreqPanel populations={v.populations} />
          </div>
        </Section>
      ) : null}

      {v.predictors ? (
        <Section title="In-silico predictors">
          <div className="keep-together">
            <PredictorGauges predictors={v.predictors} />
          </div>
        </Section>
      ) : null}

      {v.reclass ? (
        <Section title="Reclassification decision">
          <table className="table" style={{ fontSize: 12 }}>
            <tbody>
              <tr><td style={{ width: 140, color: "var(--ink-soft)" }}>Proposal</td>
                <td>{v.reclass.from} → {v.reclass.to} (Δ {v.reclass.delta})</td></tr>
              <tr><td style={{ color: "var(--ink-soft)" }}>Driven by</td>
                <td className="mono" style={{ fontSize: 11 }}>{v.reclass.criteria.join(", ")}</td></tr>
              <tr><td style={{ color: "var(--ink-soft)" }}>Decision</td><td><em>Pending</em></td></tr>
              <tr><td style={{ color: "var(--ink-soft)" }}>Curator</td><td>—</td></tr>
              <tr><td style={{ color: "var(--ink-soft)" }}>Date</td><td>—</td></tr>
            </tbody>
          </table>
        </Section>
      ) : null}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8, marginTop: 18, borderBottom: "1px solid var(--rule)", paddingBottom: 3 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function DL({ items }: { items: [string, string][] }) {
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: 4, columnGap: 16, margin: 0, fontSize: 13 }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt style={{ color: "var(--ink-soft)" }}>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <tr>
      <td style={{ color: "var(--ink-soft)", fontSize: 11, padding: "2px 12px 2px 0", verticalAlign: "top", whiteSpace: "nowrap", width: 140 }}>
        {label}
      </td>
      <td className={mono ? "mono" : ""} style={{ padding: "2px 0", verticalAlign: "top", wordBreak: "break-word" }}>
        {value}
      </td>
    </tr>
  );
}

function humanizeModel(m: InheritanceModel): string {
  switch (m) {
    case "de_novo": return "de novo";
    case "ar_hom": return "AR hom";
    case "comp_het": return "comp het";
    case "ad_inherited": return "AD inh.";
    case "het_inherited": return "het inh.";
    case "x_linked_recessive": return "XLR";
    case "x_linked_dominant": return "XLD";
    case "y_linked": return "Y-linked";
    case "mitochondrial": return "mito";
    default: return m;
  }
}

function humanizeZyg(z: string): string {
  switch (z) {
    case "hom_ref": return "Hom Ref";
    case "het": return "Heterozygous";
    case "hom_alt": return "Hom Alt";
    case "missing": return "—";
    default: return z;
  }
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
