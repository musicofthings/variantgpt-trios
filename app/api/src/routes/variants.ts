import { Hono } from "hono";
import type { Bindings, Variables } from "../bindings";

export const variantsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GET /variants/:id — full evidence ledger + populations + predictors.
variantsRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const variant = await c.env.DB.prepare("SELECT * FROM variants WHERE id = ?").bind(id).first();
  if (!variant) return c.json({ error: "not_found" }, 404);

  const [evidence, populations, predictors] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM evidence WHERE variant_id = ?").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM populations WHERE variant_id = ?").bind(id).all(),
    c.env.DB.prepare("SELECT * FROM predictors WHERE variant_id = ?").bind(id).first(),
  ]);

  return c.json({
    variant,
    evidence: evidence.results ?? [],
    populations: populations.results ?? [],
    predictors,
  });
});

// POST /variants/:id/requery-freq — live gnomAD sas + tabix-track re-query;
// recompute reclassification proposal (PRD §6.6, §4.6).
variantsRouter.post("/:id/requery-freq", async (c) => {
  const id = c.req.param("id");
  // 1. Live gnomAD GraphQL fetch (sas + global) — cached via AI Gateway / KV.
  // 2. Range-read IndiGenomes/GenomeAsia tabix from R2.
  // 3. Recompute via the same point logic as the engine (reclassify.ts mirror).
  // 4. Upsert reclass_proposal (status='pending').
  return c.json({ variant_id: id, recomputed: true, proposal_status: "pending" });
});

// POST /variants/:id/narrative — LLM-drafted interpretation (never auto-saves).
variantsRouter.post("/:id/narrative", async (c) => {
  const id = c.req.param("id");
  // Call AI Gateway → OpenRouter with structured JSON request grounded in the
  // evidence ledger fields only (no raw VCF). Log model+provider+params to audit_log.
  return c.json({
    variant_id: id,
    draft: "AI synopsis unavailable — wire AI Gateway in src/llm/narrative.ts.",
    model: "",
    ai_drafted: true,
  });
});
