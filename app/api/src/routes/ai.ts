/** AI-drafted clinical synopsis for a single variant.
 *
 * Route: POST /api/ai/synopsis
 *   Body: { variant: VariantPayload, case_context: CaseContext }
 *   Reply: { synopsis: string, model: string, generated_at: string, cached: false }
 *   Errors: 503 when ANTHROPIC_API_KEY is unset; 4xx for malformed input
 *
 * The synopsis is intentionally NEVER auto-generated for every variant — the
 * SPA invokes this on explicit user click in the workbench drawer. That keeps
 * cost predictable and forces the curator into the loop.
 *
 * Routing:
 *   - If AI_GATEWAY_ACCOUNT + AI_GATEWAY_ID are set, traffic goes via the
 *     Cloudflare AI Gateway URL so the request is logged, rate-limited, and
 *     cacheable at the edge (Cloudflare AI Gateway is free-tier-friendly).
 *   - Otherwise we hit api.anthropic.com directly.
 *
 * Disclaimer: every response is prefixed with an "AI-drafted; review before
 * signing" banner — the SPA already renders that visually, but it's repeated
 * in-band so any text exported/copied carries the warning.
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../bindings";

export const aiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const MAX_TOKENS = 800;
// Cap input prose to keep request payload bounded — Anthropic accepts up to
// ~200k tokens but the synopsis only needs the variant + case scaffolding;
// truncating each free-text input keeps cost predictable.
const MAX_HISTORY_CHARS = 2000;
const MAX_SUMMARY_CHARS = 1500;

interface VariantPayload {
  id: string;
  gene?: string;
  hgvs_c?: string;
  hgvs_p?: string;
  transcript?: string;
  consequence?: string;
  exon?: string;
  inheritance_models?: string[];
  inheritance_confidence?: string;
  baseline_tier?: string;
  reclass?: { from: string; to: string; delta: number; criteria: string[] } | null;
  af_global?: number | null;
  af_sas?: number | null;
  af_indi?: number | null;
  hpo_matches?: string[];
  clinvar?: {
    clinical_significance?: string;
    review_stars?: number;
    review_status?: string;
    conditions?: string[];
  } | null;
  evidence?: Array<{
    criterion: string;
    fired: boolean;
    strength?: string;
    summary?: string;
    trigger?: string;
    source?: string;
  }>;
  predictors?: Record<string, number | null | undefined>;
}

interface CaseContext {
  proband?: { id?: string; sex?: string; affected?: string };
  hpo?: Array<{ hpo_id: string; label?: string; definition?: string }>;
  clinical_history?: {
    text?: string;
    onset_age?: string;
    consanguinity_note?: string;
    family_history?: string;
    prior_testing?: string;
  };
  gene_info?: {
    symbol?: string;
    name?: string;
    summary?: string;
    type_of_gene?: string;
  } | null;
}

aiRouter.post("/synopsis", async (c) => {
  const key = c.env.ANTHROPIC_API_KEY;
  if (!key) {
    return c.json({ error: "ANTHROPIC_API_KEY is not configured on this worker" }, 503);
  }

  let body: { variant: VariantPayload; case_context: CaseContext };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body?.variant?.id) {
    return c.json({ error: "missing variant.id" }, 400);
  }

  const model = c.env.ANTHROPIC_MODEL_SYNOPSIS || DEFAULT_MODEL;
  const prompt = buildPrompt(body.variant, body.case_context ?? {});

  // Resolve the upstream URL — Cloudflare AI Gateway is preferred when
  // configured (gives us logs + caching + per-gateway rate limit).
  const upstream = aiGatewayUrl(c.env) ?? ANTHROPIC_API;

  let resp: Response;
  try {
    resp = await fetch(upstream, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return c.json({ error: `anthropic unreachable: ${String(e).slice(0, 200)}` }, 502);
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return c.json({ error: `anthropic ${resp.status}: ${txt.slice(0, 300)}` }, 502);
  }

  const data = await resp.json() as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    return c.json({ error: "anthropic returned empty content" }, 502);
  }

  return c.json({
    synopsis: text,
    model: data.model ?? model,
    generated_at: new Date().toISOString(),
    cached: false,
    usage: data.usage,
  });
});

/** Return the AI Gateway upstream URL when configured, else null. */
function aiGatewayUrl(env: Bindings): string | null {
  if (!env.AI_GATEWAY_ACCOUNT || !env.AI_GATEWAY_ID) return null;
  // Cloudflare AI Gateway anthropic provider proxy format:
  //   https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/messages
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT}/${env.AI_GATEWAY_ID}/anthropic/v1/messages`;
}

/** System prompt — restricts model to a clinical-narrative role, requires
 *  evidence-grounded language, and forbids classification decisions. */
const SYSTEM_PROMPT = `You are a clinical molecular geneticist drafting a single-variant interpretation paragraph for a clinical report. You write in plain, precise medical English suitable for a board-certified geneticist or genetic counselor to review and finalize.

Rules:
- Output 2–3 short paragraphs (total 150–300 words).
- Ground every statement in the structured evidence provided. Do not invent allele frequencies, ClinVar entries, or predictor scores.
- Be explicit about evidence STRENGTH (Strong / Moderate / Supporting) and direction (pathogenic / benign) when citing ACMG criteria.
- Surface conflicts honestly: if predictors disagree, or ClinVar conflicts with the case's ACMG call, say so.
- Connect the variant to the case PHENOTYPE only when an HPO match is present.
- Do NOT issue a final clinical decision or recommend treatment. The classification tier is provided as context, not for you to override.
- Do NOT use exclamation marks, marketing language, or hedging ("might possibly maybe").
- Begin the output with the exact prefix: "AI-DRAFTED · REVIEW BEFORE SIGNING ·" followed by a single space.`;

function buildPrompt(v: VariantPayload, ctx: CaseContext): string {
  const lines: string[] = [];

  // Header block — minimal identifying scaffolding.
  lines.push("=== VARIANT ===");
  lines.push(`Gene: ${v.gene ?? "—"}`);
  if (v.transcript) lines.push(`Transcript: ${v.transcript}`);
  if (v.hgvs_c) lines.push(`HGVS coding: ${v.hgvs_c}`);
  if (v.hgvs_p) lines.push(`HGVS protein: ${v.hgvs_p}`);
  if (v.exon) lines.push(`Exon: ${v.exon}`);
  if (v.consequence) lines.push(`Consequence: ${v.consequence}`);
  if (v.inheritance_models && v.inheritance_models.length) {
    const conf = v.inheritance_confidence ? ` (${v.inheritance_confidence} confidence)` : "";
    lines.push(`Inheritance: ${v.inheritance_models.join(", ")}${conf}`);
  }
  if (v.baseline_tier) lines.push(`ACMG tier (baseline): ${v.baseline_tier}`);
  if (v.reclass) {
    lines.push(
      `Reclassification (South-Asian): ${v.reclass.from} → ${v.reclass.to} (Δ ${v.reclass.delta})` +
      ` driven by ${v.reclass.criteria.join(", ")}`,
    );
  }

  // Population AF block.
  const afLines: string[] = [];
  if (v.af_global != null) afLines.push(`gnomAD global ${v.af_global}`);
  if (v.af_sas != null) afLines.push(`gnomAD SAS ${v.af_sas}`);
  if (v.af_indi != null) afLines.push(`IndiGenomes ${v.af_indi}`);
  if (afLines.length) lines.push(`Allele frequency: ${afLines.join(" · ")}`);

  // ClinVar.
  if (v.clinvar?.clinical_significance) {
    lines.push(
      `ClinVar: ${v.clinvar.clinical_significance}` +
      (v.clinvar.review_stars != null ? ` (${v.clinvar.review_stars}★ ${v.clinvar.review_status ?? ""})` : "") +
      (v.clinvar.conditions?.length ? ` for ${v.clinvar.conditions.slice(0, 3).join("; ")}` : ""),
    );
  }

  // Fired ACMG criteria with summaries.
  const fired = (v.evidence ?? []).filter((e) => e.fired);
  if (fired.length) {
    lines.push("");
    lines.push("=== FIRED ACMG CRITERIA ===");
    for (const e of fired.slice(0, 12)) {
      const parts = [`${e.criterion}${e.strength ? ` [${e.strength}]` : ""}`];
      if (e.summary) parts.push(`— ${e.summary}`);
      if (e.trigger) parts.push(`(trigger: ${e.trigger})`);
      lines.push(parts.join(" "));
    }
  }

  // Predictor scores, only the ones with values.
  const preds = Object.entries(v.predictors ?? {})
    .filter(([_, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`);
  if (preds.length) {
    lines.push("");
    lines.push(`=== IN-SILICO PREDICTORS === ${preds.slice(0, 12).join(" · ")}`);
  }

  // Case-level context.
  lines.push("");
  lines.push("=== CASE CONTEXT ===");
  if (ctx.proband) {
    const pp: string[] = [];
    if (ctx.proband.id) pp.push(`proband ${ctx.proband.id}`);
    if (ctx.proband.sex) pp.push(`sex ${ctx.proband.sex}`);
    if (ctx.proband.affected) pp.push(`affected: ${ctx.proband.affected}`);
    if (pp.length) lines.push(pp.join(" · "));
  }
  if (ctx.gene_info?.summary) {
    lines.push(`Gene function (NCBI): ${truncate(ctx.gene_info.summary, MAX_SUMMARY_CHARS)}`);
  }
  if (ctx.clinical_history) {
    const ch = ctx.clinical_history;
    const chParts: string[] = [];
    if (ch.onset_age) chParts.push(`onset ${ch.onset_age}`);
    if (ch.consanguinity_note) chParts.push(`consanguinity: ${ch.consanguinity_note}`);
    if (ch.family_history) chParts.push(`family history: ${ch.family_history}`);
    if (ch.prior_testing) chParts.push(`prior testing: ${ch.prior_testing}`);
    if (chParts.length) lines.push(chParts.join(" · "));
    if (ch.text) lines.push(`History: ${truncate(ch.text, MAX_HISTORY_CHARS)}`);
  }

  // HPO matches — only the ones the engine flagged on this variant.
  const hpoMatchSet = new Set(v.hpo_matches ?? []);
  const matchedTerms = (ctx.hpo ?? []).filter((h) => hpoMatchSet.has(h.hpo_id));
  if (matchedTerms.length) {
    lines.push("");
    lines.push("=== HPO PHENOTYPE OVERLAP ===");
    for (const t of matchedTerms.slice(0, 8)) {
      const def = t.definition ? ` — ${truncate(t.definition, 200)}` : "";
      lines.push(`${t.hpo_id} ${t.label ?? ""}${def}`);
    }
  } else if (ctx.hpo && ctx.hpo.length) {
    lines.push("Case HPO terms (none matched this gene): " + ctx.hpo.slice(0, 6).map((h) => h.label ?? h.hpo_id).join(", "));
  }

  lines.push("");
  lines.push("Write the clinical synopsis paragraph(s) per the system instructions.");
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
