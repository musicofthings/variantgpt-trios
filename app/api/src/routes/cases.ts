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

// POST /cases/:id/run — enqueue engine job. Engine pulls VCFs from R2 and
// writes case.json back via the webhook (signed with ENGINE_WEBHOOK_SECRET).
casesRouter.post("/:id/run", async (c) => {
  const caseId = c.req.param("id");
  await c.env.DB.prepare("UPDATE cases SET status = 'queued' WHERE id = ?").bind(caseId).run();
  // TODO: post a job message to a queue (Cloudflare Queues / external task runner).
  return c.json({ case_id: caseId, status: "queued" }, 202);
});

// GET /cases/:id/variants — prioritized variant list with filters.
casesRouter.get("/:id/variants", async (c) => {
  const caseId = c.req.param("id");
  const inheritance = c.req.query("inheritance_model");
  const tier = c.req.query("tier");
  const gene = c.req.query("gene");

  let sql =
    "SELECT * FROM variants WHERE case_id = ?" +
    (tier ? " AND (baseline_tier = ? OR reclass_tier = ?)" : "") +
    (gene ? " AND gene = ?" : "") +
    " ORDER BY priority_score DESC LIMIT 500";
  const binds: unknown[] = [caseId];
  if (tier) { binds.push(tier, tier); }
  if (gene) { binds.push(gene); }

  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  // inheritance_model filter is JSON-stored; filter in memory.
  let variants = rows.results ?? [];
  if (inheritance) {
    variants = variants.filter((v: any) =>
      (v.inheritance_models_json || "").includes(inheritance)
    );
  }
  return c.json({ variants });
});

// POST /cases/:id/report — generate PDF/JSON/TSV, return presigned URL.
casesRouter.post("/:id/report", async (c) => {
  const caseId = c.req.param("id");
  const key = `cases/${caseId}/reports/${Date.now()}.pdf`;
  // Report rendering runs off-edge (engine) or via a Cloudflare-compatible PDF lib.
  return c.json({ case_id: caseId, report_key: key, status: "queued" });
});
