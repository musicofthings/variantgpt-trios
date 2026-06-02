import { useMemo } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { TierChip } from "../components/TierChip";
import { ReclassBadge } from "../components/ReclassBadge";
import { PopulationFreqPanel } from "../components/PopulationFreqPanel";
import { useDemoCase } from "../caseData";
import { api, apiFetch } from "../apiBase";
import type { GeneInfoRow, HPOTermRow } from "../caseData";
import type { EvidenceRow, InheritanceModel, VariantRow } from "../types";

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
  const hpoTerms: HPOTermRow[] = data.hpo ?? [];
  const hpoById = useMemo(() => {
    const m = new Map<string, HPOTermRow>();
    for (const h of hpoTerms) m.set(h.hpo_id, h);
    return m;
  }, [hpoTerms]);
  const geneInfoMap: Record<string, GeneInfoRow> = data.gene_info ?? {};
  const ch = data.clinical_history;
  const probandMember = data.proband_member;
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

  // Server-rendered archival report — a self-contained HTML document built by
  // the Worker straight from case.json (no app shell, no JS). Fetched with the
  // Clerk JWT, then handed to the browser as a download.
  async function exportArchivalHtml() {
    const sel = selectedIds.size ? `&variants=${[...selectedIds].join(",")}` : "";
    try {
      const resp = await apiFetch(api(`/cases/${caseId}/report?format=html${sel}`));
      if (!resp.ok) {
        alert(`Archival report failed (${resp.status}).`);
        return;
      }
      const html = await resp.text();
      downloadFile(`${caseId}-report.html`, html, "text/html");
    } catch (e) {
      alert(`Archival report failed: ${String(e).slice(0, 160)}`);
    }
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
          <button onClick={exportArchivalHtml} title="Server-rendered, self-contained HTML for archival">Archival HTML</button>
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

          {/* Patient details — pedigree + clinical history block. Mirrors
              the demographics/clinical-context section on a lab report's
              first page (Apollo et al.). All fields fall back to "—" when
              the engine didn't capture them so the layout is stable. */}
          <Section title="Patient details">
            <DL items={[
              ["Proband ID", probandMember?.id ?? pedigree.proband ?? "—"],
              ["Sample name", probandMember?.sample_name ?? "—"],
              ["Sex", probandMember?.sex ?? "—"],
              ["Affected status", probandMember?.affected ?? "—"],
              ["Onset age", ch?.onset_age ?? "—"],
              ["Consanguinity", ch?.consanguinity_note ?? "—"],
              ["Family history", ch?.family_history ?? "—"],
              ["Prior testing", ch?.prior_testing ?? "—"],
            ]} />
          </Section>

          <Section title="Clinical history">
            {ch?.text ? (
              <p style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{ch.text}</p>
            ) : (
              <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                No free-text clinical summary captured at intake.
              </p>
            )}
          </Section>

          {/* HPO phenotype catalog — every HPO term entered for the case,
              with id, human-readable label, and plain-English definition
              from the HPO OBO catalog (sourced at intake via EBI OLS4). The
              definition column gives the clinician several sentences of
              context per phenotype so the report can be reviewed in
              isolation from the workbench. */}
          {hpoTerms.length > 0 ? (
            <Section title="Phenotype (HPO terms)">
              <table className="table keep-together" style={{ fontSize: 12, marginTop: 4 }}>
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>HPO ID</th>
                    <th style={{ width: 200 }}>Label</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {hpoTerms.map((h) => (
                    <tr key={h.hpo_id}>
                      <td className="mono" style={{ verticalAlign: "top" }}>{h.hpo_id}</td>
                      <td style={{ verticalAlign: "top" }}>
                        {h.label ?? <em style={{ color: "var(--ink-soft)" }}>(no label resolved)</em>}
                      </td>
                      <td style={{ verticalAlign: "top", color: "var(--ink-soft)" }}>
                        {h.definition ?? <em>(no description available; resolve via hpo.jax.org/browse/term/{h.hpo_id})</em>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          ) : null}

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
          <VariantDetailPage
            key={v.id}
            v={v}
            index={i + 1}
            total={reportVariants.length}
            caseId={caseId!}
            hpoById={hpoById}
            geneInfoMap={geneInfoMap}
          />
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
function VariantDetailPage({ v, index, total, caseId, hpoById, geneInfoMap }: {
  v: VariantRow;
  index: number;
  total: number;
  caseId: string;
  hpoById: Map<string, HPOTermRow>;
  geneInfoMap: Record<string, GeneInfoRow>;
}) {
  const geneInfo = v.gene ? geneInfoMap[v.gene] : undefined;
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

      {/* Gene-level prose — one paragraph describing what we know about the
          gene, with the Entrez/NCBI summary from mygene.info as the primary
          source. Falls back to structured data (OMIM + ClinVar conditions +
          HPO coverage) when mygene didn't resolve the gene. */}
      <Section title="Gene">
        {geneInfo?.name ? (
          <div style={{ fontSize: 12, marginBottom: 6 }}>
            <strong>{geneInfo.symbol}</strong>
            {" · "}
            <span style={{ color: "var(--ink-soft)" }}>{geneInfo.name}</span>
            {geneInfo.type_of_gene ? (
              <span style={{ color: "var(--ink-soft)" }}> · {geneInfo.type_of_gene}</span>
            ) : null}
          </div>
        ) : null}
        {geneInfo?.summary ? (
          <p style={{ fontSize: 12, marginTop: 0 }}>{geneInfo.summary}</p>
        ) : null}
        <p style={{ fontSize: 12, marginTop: geneInfo?.summary ? 8 : 0 }}>
          {geneParagraph(v)}
        </p>
      </Section>

      {/* Variant-level prose with phenotype relevance — one paragraph
          describing the variant's molecular consequence, its ACMG
          classification, and (when hpo_matches is non-empty) which of the
          case's HPO phenotypes the gene matches, with the term label AND
          its plain-English definition per matched term. */}
      <Section title="Variant findings & phenotype relevance">
        <p style={{ fontSize: 12 }}>
          {variantParagraph(v)}
        </p>
        {v.hpo_matches && v.hpo_matches.length > 0 ? (
          <ul style={{ fontSize: 11, margin: "8px 0 0 16px", padding: 0 }}>
            {v.hpo_matches.map((hp) => {
              const term = hpoById.get(hp);
              return (
                <li key={hp} style={{ marginBottom: 6 }}>
                  <span className="mono">{hp}</span>
                  {" — "}
                  <strong>{term?.label ?? "(no label resolved)"}</strong>
                  {term?.definition ? (
                    <div style={{ color: "var(--ink-soft)", marginTop: 2 }}>
                      {term.definition}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </Section>

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

      {/* Fired-only ACMG evidence — non-fired criteria are skipped to keep
          the report concise. Each fired row shows the trigger and source so
          the reasoning behind each strength assignment is auditable. */}
      <FiredEvidence rows={(v.evidence ?? []).filter((e) => e.fired)} />

      {v.populations && v.populations.length > 0 ? (
        <Section title="Population allele frequencies">
          <div className="keep-together">
            <PopulationFreqPanel populations={v.populations} />
          </div>
        </Section>
      ) : null}

      {v.predictors ? (
        <Section title="In-silico predictors">
          <PredictorTable predictors={v.predictors} />
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

/** Detailed in-silico predictor table for the report. Shows every available
 *  predictor with its raw score, calibration threshold, and a one-glance
 *  interpretation (Damaging / Tolerated / —). Each predictor has its own
 *  direction convention; this table renders them all natively so a clinician
 *  doesn't have to remember that SIFT is low=damaging while PolyPhen is
 *  high=damaging. */
type PredictorSpec = {
  key: keyof import("../types").Predictors;
  label: string;
  threshold: number;
  /** true if HIGH score = damaging (default); false if LOW = damaging. */
  higherIsPathogenic: boolean;
  format: (n: number) => string;
  /** What the threshold means in plain English — shown in the description col. */
  note: string;
};
const PREDICTOR_SPECS: PredictorSpec[] = [
  { key: "alphamissense",  label: "AlphaMissense", threshold: 0.564,  higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "ClinGen PP3 ≥0.564 / BP4 ≤0.116" },
  { key: "revel",          label: "REVEL",         threshold: 0.644,  higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "ClinGen PP3 ≥0.644 / BP4 ≤0.290" },
  { key: "cadd",           label: "CADD (PHRED)",  threshold: 25.3,   higherIsPathogenic: true,  format: (n) => n.toFixed(1),
    note: "ClinGen PP3 ≥25.3; >20 = top 1% deleterious" },
  { key: "spliceai",       label: "SpliceAI Δ",    threshold: 0.2,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "ClinGen SVI ≥0.2 supporting; ≥0.5 strong splice impact" },
  { key: "sift_score",     label: "SIFT",          threshold: 0.05,   higherIsPathogenic: false, format: (n) => n.toFixed(3),
    note: "<0.05 = deleterious (SIFT convention)" },
  { key: "polyphen2_hvar", label: "PolyPhen2 HVAR",threshold: 0.957,  higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: ">0.957 probably damaging; >0.453 possibly damaging" },
  { key: "polyphen2_hdiv", label: "PolyPhen2 HDIV",threshold: 0.957,  higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "Trained on disease vs neutral (HumDiv); same thresholds" },
  { key: "mutation_taster",label: "MutationTaster",threshold: 0.5,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: ">0.5 = damaging" },
  { key: "lrt",            label: "LRT",           threshold: 0.5,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "Likelihood-ratio test on conservation" },
  { key: "fathmm",         label: "FATHMM",        threshold: -1.5,   higherIsPathogenic: false, format: (n) => n.toFixed(2),
    note: "<-1.5 = damaging (FATHMM convention)" },
  { key: "provean",        label: "PROVEAN",       threshold: -2.5,   higherIsPathogenic: false, format: (n) => n.toFixed(2),
    note: "<-2.5 = damaging" },
  { key: "metasvm",        label: "MetaSVM",       threshold: 0,      higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "Ensemble; >0 = damaging" },
  { key: "metalr",         label: "MetaLR",        threshold: 0.5,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "Ensemble logistic regression; >0.5 = damaging" },
  { key: "vest4",          label: "VEST4",         threshold: 0.5,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: ">0.5 commonly damaging" },
  { key: "phylop",         label: "phyloP rank",   threshold: 0.5,    higherIsPathogenic: true,  format: (n) => n.toFixed(3),
    note: "100-way vertebrate rank; high = conserved" },
  { key: "gerp",           label: "GERP",          threshold: 2.0,    higherIsPathogenic: true,  format: (n) => n.toFixed(2),
    note: "Rejected substitutions; >2 = conserved" },
];

function PredictorTable({ predictors }: { predictors: import("../types").Predictors }) {
  const rows = PREDICTOR_SPECS.filter((s) => predictors[s.key] != null);
  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>
        No in-silico predictor scores available for this variant.
      </p>
    );
  }
  return (
    <table className="table keep-together" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>Predictor</th>
          <th className="num">Score</th>
          <th>Call</th>
          <th>Interpretation</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const v = predictors[s.key]!;
          const damaging = s.higherIsPathogenic ? v >= s.threshold : v <= s.threshold;
          return (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td className="num mono">{s.format(v)}</td>
              <td style={{ color: damaging ? "var(--rust, #b04a2a)" : "var(--ink-soft)" }}>
                <strong>{damaging ? "Damaging" : "Tolerated"}</strong>
              </td>
              <td style={{ color: "var(--ink-soft)", fontSize: 11 }}>{s.note}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Compact fired-only ACMG evidence table for the report. Skips non-fired
 *  criteria entirely so the report is not bloated with rows that say "not
 *  fired" — those are inspectable in the workbench drawer. */
function FiredEvidence({ rows }: { rows: EvidenceRow[] }) {
  if (!rows.length) {
    return (
      <Section title="ACMG evidence (fired)">
        <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          No ACMG criteria fired for this variant.
        </p>
      </Section>
    );
  }
  return (
    <Section title="ACMG evidence (fired)">
      <table className="table keep-together" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ width: 90 }}>Criterion</th>
            <th style={{ width: 90 }}>Strength</th>
            <th>Summary</th>
            <th>Trigger / source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.criterion}>
              <td className="mono">{r.criterion}</td>
              <td>{r.strength ?? "—"}</td>
              <td>{r.summary ?? "Fired"}</td>
              <td style={{ fontSize: 11 }}>
                {r.trigger ? <div className="mono">{r.trigger}</div> : null}
                {r.source ? <div style={{ color: "var(--ink-soft)" }}>{r.source}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Build a gene-level prose paragraph. We don't have a curated gene summary
 *  source wired yet, so the paragraph is composed from the structured data
 *  we DO have: gene symbol, OMIM accession, ClinVar conditions tied to the
 *  gene (when available), and a note about HPO-catalog coverage. Falls back
 *  gracefully when fields are absent. */
function geneParagraph(v: VariantRow): React.ReactNode {
  const parts: React.ReactNode[] = [];
  parts.push(<><strong>{v.gene ?? "This gene"}</strong></>);
  if (v.omim_id) {
    parts.push(<> (OMIM <span className="mono">*{v.omim_id}</span>)</>);
  }
  parts.push(<> is reported in the MANE Select transcript <span className="mono">{v.transcript ?? "—"}</span>.</>);

  const conditions = v.clinvar?.conditions?.filter(Boolean) ?? [];
  if (conditions.length > 0) {
    parts.push(<> ClinVar links this gene to {conditions.slice(0, 4).join("; ")}{conditions.length > 4 ? ", among others" : ""}.</>);
  }

  if (v.hpo_matches && v.hpo_matches.length > 0) {
    parts.push(<> The HPO consortium <em>genes_to_phenotype</em> catalog records gene–phenotype associations for {v.gene} that overlap with {v.hpo_matches.length} of the case's recorded clinical phenotypes (detailed below).</>);
  } else {
    parts.push(<> No overlap was found between this gene's HPO associations and the case's recorded phenotype terms; this does not exclude pathogenicity but reduces phenotype-driven prior probability.</>);
  }
  return <>{parts}</>;
}

/** Build a variant-level prose paragraph. Covers: molecular consequence,
 *  zygosity in the proband, inheritance model with confidence, ACMG tier,
 *  reclassification narrative (if any), and a phenotype-relevance closing
 *  sentence referencing the HPO overlap. */
function variantParagraph(v: VariantRow): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const probandCall = v.calls?.find((c) => c.role === "proband");
  const zyg = probandCall ? humanizeZyg(probandCall.zygosity).toLowerCase() : null;

  parts.push(<>The variant </>);
  parts.push(<span className="mono">{v.hgvs_c}</span>);
  if (v.hgvs_p) parts.push(<> (<span className="mono">{v.hgvs_p}</span>)</>);
  parts.push(<> is a <strong>{v.consequence ?? "sequence variant"}</strong></>);
  if (v.exon) parts.push(<> in exon {v.exon}</>);
  if (zyg) parts.push(<>, identified in the proband as <strong>{zyg}</strong></>);
  parts.push(<>. </>);

  if (v.inheritance_models.length) {
    const conf = v.inheritance_confidence ? ` with ${v.inheritance_confidence} confidence` : "";
    parts.push(<>Segregation analysis is consistent with <strong>{v.inheritance_models.map(humanizeModel).join(" / ")}</strong>{conf}. </>);
  }

  const fired = (v.evidence ?? []).filter((e) => e.fired);
  if (fired.length) {
    parts.push(<>ACMG/AMP classification — <TierChip tier={v.baseline_tier} /> — is driven by <span className="mono">{fired.map((e) => e.criterion).join(", ")}</span>. </>);
  } else {
    parts.push(<>ACMG/AMP classification: <TierChip tier={v.baseline_tier} />. </>);
  }

  if (v.reclass) {
    parts.push(<>South-Asian allele-frequency review reclassified this variant from <strong>{v.reclass.from}</strong> to <strong>{v.reclass.to}</strong> (Δ {v.reclass.delta}), driven by {v.reclass.criteria.join(", ")}. </>);
  }

  if (v.clinvar?.clinical_significance) {
    parts.push(<>ClinVar records this variant as <strong>{v.clinvar.clinical_significance}</strong>
      {v.clinvar.review_stars != null ? <> ({v.clinvar.review_stars}★ review status)</> : null}. </>);
  }

  if (v.hpo_matches && v.hpo_matches.length > 0) {
    parts.push(<>The proband's phenotype includes {v.hpo_matches.length} HPO term{v.hpo_matches.length === 1 ? "" : "s"} associated with {v.gene}, supporting clinical relevance.</>);
  } else {
    parts.push(<>No direct HPO overlap was identified between {v.gene} and the case's recorded phenotype.</>);
  }

  return <>{parts}</>;
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
