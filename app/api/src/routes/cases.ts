// ⚠️  UNMOUNTED — NOT reachable in production. See app/api/src/index.ts.
//
// This was a second, RESTful case API intended for a future curator UI. It is
// NOT wired into the app: the SPA talks exclusively to /api/* (routes/api.ts),
// which is the canonical, ownership-enforced surface. Kept for reference when
// the curator UI is built. Before re-mounting, this router MUST:
//   1. enforce case ownership (port caseAccessGate from routes/api.ts), and
//   2. stop duplicating case/run/report logic that already lives in api.ts.
// Do not re-export into index.ts until both are done.
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings, Variables } from "../bindings";

export const casesRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const CreateCase = z.object({ name: z.string().min(1) });

// POST /cases — create case metadata.
casesRouter.post("/", async (c) => {
  const body = CreateCase.parse(await c.req.json());
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO cases (id, name, created_at, status) VALUES (?, ?, datetime('now'), 'draft')"
  ).bind(id, body.name).run();
  return c.json({ id, name: body.name, status: "draft" }, 201);
});

// GET /cases/:id — case + status.
casesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM cases WHERE id = ?").bind(id).first();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

// POST /cases/:id/members — add member + presign R2 upload for VCF.
const AddMember = z.object({
  role: z.enum(["proband", "father", "mother", "sibling", "relative"]),
  sex: z.enum(["male", "female", "unknown"]),
  affected: z.enum(["affected", "unaffected", "unknown"]),
  sample_name: z.string().optional(),
});

casesRouter.post("/:id/members", async (c) => {
  const caseId = c.req.param("id");
  const body = AddMember.parse(await c.req.json());
  const memberId = crypto.randomUUID();
  const vcfKey = `cases/${caseId}/vcf/${memberId}.vcf.gz`;

  await c.env.DB.prepare(
    `INSERT INTO members (id, case_id, role, sex, affected, sample_name, vcf_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(memberId, caseId, body.role, body.sex, body.affected, body.sample_name ?? null, vcfKey).run();

  // R2 presigned upload — Workers does this via a server-issued upload URL.
  // For now return the key; client streams to a sibling /upload endpoint that
  // writes to env.BUCKET directly (added when upload path is wired).
  return c.json({ id: memberId, vcf_r2_key: vcfKey }, 201);
});

// POST /cases/:id/hpo — add/confirm HPO terms.
const HPOBody = z.object({
  terms: z.array(z.object({
    hpo_id: z.string().regex(/^HP:\d{7}$/),
    label: z.string().optional(),
    source: z.enum(["manual", "llm_confirmed"]).default("manual"),
  })),
});

casesRouter.post("/:id/hpo", async (c) => {
  const caseId = c.req.param("id");
  const { terms } = HPOBody.parse(await c.req.json());
  const stmts = terms.map((t) =>
    c.env.DB.prepare(
      `INSERT INTO hpo_terms (id, case_id, hpo_id, label, source) VALUES (?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), caseId, t.hpo_id, t.label ?? null, t.source)
  );
  await c.env.DB.batch(stmts);
  return c.json({ added: terms.length });
});

// POST /cases/:id/clinical — save free-text history; LLM extracts HPO candidates.
const ClinicalBody = z.object({
  text: z.string().min(1),
  onset_age: z.string().optional(),
  consanguinity: z.boolean().optional(),
  prior_testing: z.string().optional(),
});

casesRouter.post("/:id/clinical", async (c) => {
  const caseId = c.req.param("id");
  const body = ClinicalBody.parse(await c.req.json());
  await c.env.DB.prepare(
    `INSERT INTO clinical_history (case_id, text, onset_age, consanguinity, prior_testing)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(case_id) DO UPDATE SET
       text=excluded.text, onset_age=excluded.onset_age,
       consanguinity=excluded.consanguinity, prior_testing=excluded.prior_testing`
  ).bind(caseId, body.text, body.onset_age ?? null, body.consanguinity ? 1 : 0, body.prior_testing ?? null).run();

  // LLM HPO extraction lands in src/llm/hpo_extract.ts (AI Gateway → OpenRouter).
  const candidates: { hpo_id: string; label: string }[] = [];
  return c.json({ saved: true, hpo_candidates: candidates });
});

// POST /cases/:id/run — NOT IMPLEMENTED on this router. The real dispatch lives
// at POST /api/cases/:id/run (routes/api.ts::kickEngineRun), which signs R2
// URLs and invokes the Fly engine. The previous version here set status to
// 'queued' but never enqueued anything, leaving cases stuck forever — worse
// than a clear error. Return 501 so a caller can't mistake it for a real run.
casesRouter.post("/:id/run", (c) =>
  c.json({ error: "not_implemented", use: "POST /api/cases/:id/run" }, 501),
);

// GET /cases/:id/variants — prioritized variant list with filters.
casesRouter.get("/:id/variants", async (c) => {
  const caseId = c.req.param("id");
  const inheritance = c.req.query("inheritance_model");
  const tier = c.req.query("tier");
  const gene = c.req.query("gene");

  // Every filter — including inheritance_model — must be applied BEFORE the
  // LIMIT, or the cap silently drops matching variants that ranked outside the
  // global top-500. inheritance_models_json is a JSON array of enum strings, so
  // a LIKE on the quoted token is an exact membership test (models never
  // substring one another: "AR" vs "AR_hom" would need word boundaries, but the
  // stored tokens are full enum values, so we match the quoted form).
  let sql =
    "SELECT * FROM variants WHERE case_id = ?" +
    (tier ? " AND (baseline_tier = ? OR reclass_tier = ?)" : "") +
    (gene ? " AND gene = ?" : "") +
    (inheritance ? " AND inheritance_models_json LIKE ?" : "") +
    " ORDER BY priority_score DESC LIMIT 500";
  const binds: unknown[] = [caseId];
  if (tier) { binds.push(tier, tier); }
  if (gene) { binds.push(gene); }
  if (inheritance) { binds.push(`%"${inheritance}"%`); }

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ variants: rows.results ?? [] });
});

// POST /cases/:id/report — NOT IMPLEMENTED here. The real report renderer is
// GET|POST /api/cases/:id/report (routes/api.ts), which builds a self-contained
// HTML/PDF from case.json. The previous stub returned a report_key for a file
// it never wrote.
casesRouter.post("/:id/report", (c) =>
  c.json({ error: "not_implemented", use: "GET /api/cases/:id/report" }, 501),
);
