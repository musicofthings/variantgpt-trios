/** Server-side clinical report renderer.
 *
 * Builds a fully self-contained, print-ready HTML document straight from the
 * engine's case.json (CaseEmission). Unlike the SPA report page, this output
 * has NO client JavaScript and makes NO /api calls — every value is inlined —
 * so it's a stable archival artifact and can be handed to a headless browser
 * for PDF rendering without needing a Clerk session.
 *
 * The layout mirrors app/web/src/pages/Report.tsx: cover + patient details +
 * clinical history + HPO table + selected-findings summary, then one detail
 * page per selected variant (clinical summary, gene prose, fired-only ACMG
 * evidence, family calls, population AFs, predictors, reclassification).
 *
 * buildReportHtml is pure (emission in + curator decisions in, HTML string out)
 * and unit-tested.
 */
import {
  isLive, resolveTier,
  type DecisionRow, type ProposalLike, type TierState,
} from "./decisions";

// ---- Structural subset of the engine CaseEmission we consume ----

export interface ReportEvidence {
  criterion: string;
  fired: boolean;
  strength?: string | null;
  points?: number;
  source?: string;
  detail?: string;
}

export interface ReportVariant {
  id: string;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  gene?: string | null;
  transcript?: string | null;
  hgvs_c?: string | null;
  hgvs_p?: string | null;
  consequence?: string | null;
  exon?: string | null;
  genomic_hgvs?: string | null;
  omim_id?: string | null;
  hpo_matches?: string[] | null;
  calls?: Array<{
    member_id: string;
    role: string;
    zygosity: string;
    depth?: number | null;
    allele_balance?: number | null;
    gq?: number | null;
  }> | null;
  inheritance_models?: string[];
  inheritance_confidence?: string;
  populations?: Array<{ source: string; af?: number | null; ac?: number; an?: number; n_hom?: number }>;
  predictors?: Record<string, number | null | undefined>;
  clinvar?: {
    clinical_significance?: string | null;
    review_stars?: number | null;
    review_status?: string | null;
    conditions?: string[] | null;
  } | null;
  evidence?: ReportEvidence[];
  baseline_tier?: string | null;
  baseline_points?: number;
  reclass_tier?: string | null;
  reclass_delta?: number | null;
  priority_score?: number;
}

export interface ReportEmission {
  case_id: string;
  build?: string;
  pedigree?: {
    members?: Array<{ id: string; role: string; sex?: string; affected?: string; sample_name?: string }>;
    consanguinity?: boolean;
  };
  hpo?: Array<{ hpo_id: string; label?: string | null; definition?: string | null }>;
  gene_info?: Record<string, { symbol?: string; name?: string; summary?: string; type_of_gene?: string; omim_id?: string }>;
  clinical_history?: {
    text?: string;
    onset_age?: string;
    consanguinity_note?: string;
    prior_testing?: string;
    family_history?: string;
  } | null;
  variants?: ReportVariant[];
  /** South-Asian reclassification proposals. Each is `pending` until a curator
   *  signs off — see the decisions argument to buildReportHtml. */
  proposals?: ProposalLike[];
  versions?: Record<string, string>;
}

/** Proposals + curator decisions, resolved once and threaded through rendering
 *  so every tier printed on the report comes from the same rule. */
interface TierCtx {
  proposals: Map<string, ProposalLike>;
  decisions: Map<string, DecisionRow>;
}

const TIER_STATE_LABEL: Record<TierState, string> = {
  no_proposal: "",
  pending: "Awaiting curator review",
  stale: "Needs re-review — the proposal changed after it was decided",
  accepted: "Accepted by curator",
  modified: "Modified by curator",
  rejected: "Rejected by curator",
};

const STRENGTH_LABEL: Record<string, string> = {
  VS: "Very Strong",
  S: "Strong",
  M: "Moderate",
  P: "Supporting",
  BS: "Strong",
  BP: "Supporting",
  BA: "Stand-alone",
};

/** Cap how many variant detail pages we render when no explicit selection is
 *  given — keeps an "archive everything" call from producing a 5000-page PDF. */
const MAX_DEFAULT_VARIANTS = 50;

export function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtAf(af: number | null | undefined): string {
  if (af === null || af === undefined) return "—";
  if (af === 0) return "0";
  if (af < 1e-4) return af.toExponential(2);
  return af.toFixed(5);
}

function pickVariants(
  emission: ReportEmission,
  selectedIds?: string[],
): ReportVariant[] {
  const all = emission.variants ?? [];
  if (selectedIds && selectedIds.length) {
    const set = new Set(selectedIds);
    return all.filter((v) => set.has(v.id));
  }
  // No selection → archival mode. Prefer reclassified variants, then highest
  // priority, capped.
  return [...all]
    .sort((a, b) => {
      const ra = a.reclass_delta ? 1 : 0;
      const rb = b.reclass_delta ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return (b.priority_score ?? 0) - (a.priority_score ?? 0);
    })
    .slice(0, MAX_DEFAULT_VARIANTS);
}

/**
 * The classification this report prints for a variant.
 *
 * Delegates to resolveTier (src/decisions.ts) so paper and screen can't
 * disagree. Note this deliberately does NOT print `reclass_tier` just because
 * the engine proposed it: a pending, stale, or rejected proposal reports the
 * baseline tier. A signed report must never assert a reclassification that no
 * human approved (PRD §4.10).
 */
function tierOf(v: ReportVariant, ctx: TierCtx): { tier: string; state: TierState } {
  return resolveTier(v, ctx.proposals.get(v.id), ctx.decisions.get(v.id));
}

function patientDetails(emission: ReportEmission): string {
  const members = emission.pedigree?.members ?? [];
  const proband = members.find((m) => m.role === "proband") ?? members[0];
  const ch = emission.clinical_history ?? {};
  const rows: Array<[string, string]> = [
    ["Proband ID", esc(proband?.id)],
    ["Sample", esc(proband?.sample_name)],
    ["Sex", esc(proband?.sex)],
    ["Affected status", esc(proband?.affected)],
    ["Genome build", esc(emission.build)],
    ["Age of onset", esc(ch.onset_age)],
    ["Consanguinity", emission.pedigree?.consanguinity ? "Yes" : esc(ch.consanguinity_note) || "Not reported"],
    ["Family history", esc(ch.family_history)],
    ["Prior testing", esc(ch.prior_testing)],
  ];
  return `<table class="kv">${rows
    .map(([k, val]) => `<tr><th>${k}</th><td>${val || "—"}</td></tr>`)
    .join("")}</table>`;
}

function hpoTable(emission: ReportEmission): string {
  const hpo = emission.hpo ?? [];
  if (!hpo.length) return `<p class="muted">No HPO terms recorded.</p>`;
  return `<table class="grid"><thead><tr><th>HPO ID</th><th>Term</th><th>Definition</th></tr></thead><tbody>${hpo
    .map(
      (t) =>
        `<tr><td class="mono">${esc(t.hpo_id)}</td><td>${esc(t.label)}</td><td class="muted">${esc(t.definition)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function findingsSummary(variants: ReportVariant[], ctx: TierCtx): string {
  if (!variants.length) return `<p class="muted">No variants selected.</p>`;
  return `<table class="grid"><thead><tr><th>Gene</th><th>Variant (c. / p.)</th><th>Consequence</th><th>Inheritance</th><th>Classification</th></tr></thead><tbody>${variants
    .map((v) => {
      const t = tierOf(v, ctx);
      return `<tr><td>${esc(v.gene)}</td><td class="mono">${esc(v.hgvs_c)} ${esc(v.hgvs_p)}</td><td>${esc(v.consequence)}</td><td>${esc((v.inheritance_models ?? []).join(", "))}</td><td><strong>${esc(t.tier)}</strong></td></tr>`;
    })
    .join("")}</tbody></table>`;
}

/**
 * Cover-page ledger of every reclassification proposal touching a selected
 * variant, and what a curator did about it. This is the §4.10 audit surface:
 * who decided, when, and why — or an explicit "awaiting review" when nobody
 * has.
 */
function reclassLedger(variants: ReportVariant[], ctx: TierCtx): string {
  const rows = variants
    .map((v) => ({ v, p: ctx.proposals.get(v.id), d: ctx.decisions.get(v.id) }))
    .filter((r): r is { v: ReportVariant; p: ProposalLike; d: DecisionRow | undefined } => r.p != null);
  if (!rows.length) return "";

  const undecided = rows.filter(({ p, d }) => !isLive(p, d)).length;
  const banner = undecided
    ? `<p class="pending-note"><strong>${undecided} of ${rows.length} reclassification proposal${rows.length === 1 ? "" : "s"} ${undecided === 1 ? "is" : "are"} awaiting curator review.</strong> Undecided proposals are NOT applied — those variants are reported at their baseline classification.</p>`
    : "";

  const body = rows
    .map(({ v, p, d }) => {
      const live = isLive(p, d);
      const state = tierOf(v, ctx).state;
      const who = live && d ? esc(d.curator_name ?? d.curator) : "—";
      const when = live && d ? esc(d.decided_at) : "—";
      const note = live && d?.note ? esc(d.note) : d && !live ? "Superseded by a re-run — requires re-review." : "";
      return `<tr>
        <td>${esc(v.gene)}<div class="mono muted">${esc(v.hgvs_c)}</div></td>
        <td>${esc(p.from_tier)} → ${esc(p.to_tier)}</td>
        <td><strong>${esc(TIER_STATE_LABEL[state])}</strong></td>
        <td>${esc(tierOf(v, ctx).tier)}</td>
        <td>${who}</td>
        <td class="muted">${when}</td>
        <td>${note}</td>
      </tr>`;
    })
    .join("");

  return `<h3>Reclassification proposals &amp; curator decisions</h3>
    ${banner}
    <table class="grid"><thead><tr>
      <th>Variant</th><th>Proposed</th><th>Decision</th><th>Reported as</th>
      <th>Curator</th><th>Decided</th><th>Note</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function firedEvidence(v: ReportVariant): string {
  const fired = (v.evidence ?? []).filter((e) => e.fired);
  if (!fired.length) return `<p class="muted">No ACMG criteria fired.</p>`;
  return `<table class="grid"><thead><tr><th>Criterion</th><th>Strength</th><th>Source</th><th>Detail</th></tr></thead><tbody>${fired
    .map(
      (e) =>
        `<tr><td class="mono"><strong>${esc(e.criterion)}</strong></td><td>${esc(e.strength ? STRENGTH_LABEL[e.strength] ?? e.strength : "")}</td><td class="muted">${esc(e.source)}</td><td>${esc(e.detail)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function familyCalls(v: ReportVariant): string {
  const calls = v.calls ?? [];
  if (!calls.length) return "";
  return `<h4>Family genotype calls</h4><table class="grid"><thead><tr><th>Member</th><th>Role</th><th>Zygosity</th><th>Depth</th><th>AB</th><th>GQ</th></tr></thead><tbody>${calls
    .map(
      (c) =>
        `<tr><td>${esc(c.member_id)}</td><td>${esc(c.role)}</td><td>${esc(c.zygosity)}</td><td>${esc(c.depth)}</td><td>${c.allele_balance != null ? esc(c.allele_balance.toFixed(2)) : "—"}</td><td>${esc(c.gq)}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function populationAfs(v: ReportVariant): string {
  const pops = v.populations ?? [];
  if (!pops.length) return "";
  return `<h4>Population allele frequencies</h4><table class="grid"><thead><tr><th>Source</th><th>AF</th><th>AC / AN</th><th>Hom</th></tr></thead><tbody>${pops
    .map(
      (p) =>
        `<tr><td>${esc(p.source)}</td><td>${fmtAf(p.af)}</td><td>${p.ac != null && p.an != null ? `${esc(p.ac)} / ${esc(p.an)}` : "—"}</td><td>${esc(p.n_hom ?? "—")}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function predictorTable(v: ReportVariant): string {
  const preds = Object.entries(v.predictors ?? {}).filter(([, val]) => val != null);
  if (!preds.length) return "";
  return `<h4>In-silico predictors</h4><table class="grid"><thead><tr><th>Predictor</th><th>Score</th></tr></thead><tbody>${preds
    .map(([k, val]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(val)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function clinvarBlock(v: ReportVariant): string {
  const cv = v.clinvar;
  if (!cv?.clinical_significance) return "";
  const stars = cv.review_stars != null ? ` (${cv.review_stars}★ ${esc(cv.review_status)})` : "";
  const conds = cv.conditions?.length ? ` — ${esc(cv.conditions.slice(0, 4).join("; "))}` : "";
  return `<p><strong>ClinVar:</strong> ${esc(cv.clinical_significance)}${stars}${conds}</p>`;
}

function variantPage(v: ReportVariant, emission: ReportEmission, ctx: TierCtx): string {
  const gi = v.gene ? emission.gene_info?.[v.gene] : undefined;
  const genePara = gi?.summary
    ? `<p class="prose"><strong>${esc(gi.name ?? v.gene)}.</strong> ${esc(gi.summary)}</p>`
    : "";
  const t = tierOf(v, ctx);
  const proposal = ctx.proposals.get(v.id);
  const decision = ctx.decisions.get(v.id);
  // The proposal block states its own standing explicitly. An un-acted-on
  // proposal reads as a proposal, never as a classification.
  const reclass = proposal
    ? `<p class="reclass">
        <strong>Reclassification proposed (South-Asian cohort):</strong>
        ${esc(proposal.from_tier)} → ${esc(proposal.to_tier)}${v.reclass_delta ? ` (Δ ${esc(v.reclass_delta)})` : ""}<br>
        <strong>Curator decision:</strong> ${esc(TIER_STATE_LABEL[t.state])}${
          isLive(proposal, decision) && decision
            ? ` — ${esc(decision.curator_name ?? decision.curator)}, ${esc(decision.decided_at)}${decision.note ? `<br><em>${esc(decision.note)}</em>` : ""}`
            : ". This proposal has not been applied; the classification below is the baseline."
        }
      </p>`
    : "";
  return `<section class="variant-page">
    <h2>${esc(v.gene ?? "—")} <span class="mono">${esc(v.hgvs_c)} ${esc(v.hgvs_p)}</span></h2>
    <table class="kv">
      <tr><th>Transcript</th><td class="mono">${esc(v.transcript)}</td></tr>
      <tr><th>Exon</th><td>${esc(v.exon)}</td></tr>
      <tr><th>Genomic</th><td class="mono">${esc(v.genomic_hgvs ?? `${v.chrom}:${v.pos} ${v.ref}>${v.alt}`)}</td></tr>
      <tr><th>Consequence</th><td>${esc(v.consequence)}</td></tr>
      <tr><th>Inheritance</th><td>${esc((v.inheritance_models ?? []).join(", "))} ${v.inheritance_confidence ? `(${esc(v.inheritance_confidence)} confidence)` : ""}</td></tr>
      <tr><th>OMIM</th><td>${esc(v.omim_id)}</td></tr>
      <tr><th>Classification</th><td><strong>${esc(t.tier)}</strong></td></tr>
    </table>
    ${genePara}
    ${clinvarBlock(v)}
    ${reclass}
    <h4>ACMG evidence (fired)</h4>
    ${firedEvidence(v)}
    ${familyCalls(v)}
    ${populationAfs(v)}
    ${predictorTable(v)}
  </section>`;
}

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; margin: 0; font-size: 11pt; line-height: 1.45; }
  .page { padding: 18mm 16mm; }
  h1 { font-size: 22pt; margin: 0 0 4pt; }
  h2 { font-size: 15pt; border-bottom: 1.5px solid #0c5d54; padding-bottom: 4pt; margin: 0 0 10pt; }
  h3 { font-size: 12pt; color: #0c5d54; margin: 18pt 0 6pt; }
  h4 { font-size: 10.5pt; margin: 14pt 0 4pt; color: #333; }
  .muted { color: #666; }
  .mono { font-family: "SFMono-Regular", Consolas, monospace; font-size: 9.5pt; }
  .prose { margin: 8pt 0; }
  .reclass { background: #f5efe6; border-left: 3px solid #b07d2b; padding: 6pt 10pt; margin: 8pt 0; }
  .pending-note { border: 1px solid #b07d2b; background: #fbf6ee; padding: 6pt 10pt; margin: 6pt 0; font-size: 9.5pt; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0; }
  table.kv th { text-align: left; width: 32%; vertical-align: top; padding: 3pt 8pt 3pt 0; color: #444; font-weight: normal; }
  table.kv td { padding: 3pt 0; }
  table.grid th, table.grid td { border: 1px solid #ddd; padding: 4pt 7pt; text-align: left; font-size: 9.5pt; vertical-align: top; }
  table.grid thead th { background: #f3f3f1; }
  .cover-meta { color: #555; margin-top: 10pt; }
  .disclaimer { margin-top: 22pt; padding: 10pt; border: 1px solid #ccc; font-size: 9pt; color: #555; }
  .variant-page { page-break-before: always; }
  @page { size: A4; margin: 0; }
`;

/**
 * Render the archival clinical report.
 *
 * `decisions` are the LIVE curator decisions (one per variant, newest wins) —
 * see GET /api/cases/:id/decisions. Omitting them is not "no proposals", it's
 * "nothing signed off": every proposal then renders as awaiting review and the
 * baseline tier is what gets reported.
 */
export function buildReportHtml(
  emission: ReportEmission,
  selectedIds?: string[],
  decisions?: DecisionRow[],
): string {
  const variants = pickVariants(emission, selectedIds);

  const proposals = new Map((emission.proposals ?? []).map((p) => [p.variant_id, p]));
  // reclassify_all() sets variant.reclass_tier and emits a proposal together,
  // so these always pair in a well-formed emission. If we're handed one where
  // they don't (truncated/legacy case.json), synthesize the proposal rather
  // than dropping the reclassification from the report entirely. A synthesized
  // proposal can't match any recorded decision's fingerprint, so it correctly
  // lands as needing review instead of silently reporting as approved.
  for (const v of variants) {
    if (v.reclass_tier && !proposals.has(v.id)) {
      proposals.set(v.id, {
        variant_id: v.id,
        from_tier: v.baseline_tier ?? "VUS",
        to_tier: v.reclass_tier,
        changed_criteria: [],
      });
    }
  }

  const ctx: TierCtx = {
    proposals,
    decisions: new Map((decisions ?? []).map((d) => [d.variant_id, d])),
  };
  const generated = new Date().toISOString().slice(0, 10);
  const versions = Object.entries(emission.versions ?? {})
    .map(([k, val]) => `${esc(k)} ${esc(val)}`)
    .join(" · ");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>VariantGPT clinical report — ${esc(emission.case_id)}</title>
<style>${STYLE}</style>
</head><body>
<div class="page">
  <h1>VariantGPT Clinical Report</h1>
  <div class="cover-meta">
    Case <strong>${esc(emission.case_id)}</strong> · Genome build ${esc(emission.build)} · Generated ${generated}
  </div>

  <h3>Patient details</h3>
  ${patientDetails(emission)}

  ${emission.clinical_history?.text ? `<h3>Clinical history</h3><p class="prose">${esc(emission.clinical_history.text)}</p>` : ""}

  <h3>Phenotype (HPO terms)</h3>
  ${hpoTable(emission)}

  <h3>Selected findings</h3>
  ${findingsSummary(variants, ctx)}

  ${reclassLedger(variants, ctx)}

  <div class="disclaimer">
    <strong>RESEARCH USE ONLY — NOT FOR DIAGNOSTIC PURPOSES.</strong>
    This report was generated by VariantGPT. All variant classifications are
    provisional and must be confirmed by a qualified clinical molecular
    geneticist before being used for patient care. Reclassification proposals
    derived from South-Asian cohort allele frequencies are advisory and are only
    applied where a curator has recorded a decision above. Pipeline versions:
    ${versions || "—"}.
  </div>
</div>

${variants.map((v) => `<div class="page">${variantPage(v, emission, ctx)}</div>`).join("\n")}

</body></html>`;
}
