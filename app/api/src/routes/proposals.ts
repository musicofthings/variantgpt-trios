// ⚠️  UNMOUNTED — not wired into index.ts. This holds the curator reclass-
// decision flow (PRD §4.10) but is unreachable until the curator UI is built.
// Before re-mounting, add owner scoping (see caseAccessGate in routes/api.ts):
// a decision must only be recordable by the owner of the proposal's case.
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings, Variables } from "../bindings";

export const proposalsRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const Decision = z.object({
  action: z.enum(["accept", "reject", "modify"]),
  note: z.string().optional(),
  modified_to_tier: z.enum(["P", "LP", "VUS", "LB", "B"]).optional(),
  curator: z.string().min(1),
});

// POST /proposals/:id/decision — append-only audit per PRD §4.10.
proposalsRouter.post("/:id/decision", async (c) => {
  const proposalId = c.req.param("id");
  const body = Decision.parse(await c.req.json());

  const proposal = await c.env.DB.prepare(
    "SELECT * FROM reclass_proposals WHERE id = ?"
  ).bind(proposalId).first<{ id: string; variant_id: string; status: string }>();
  if (!proposal) return c.json({ error: "not_found" }, 404);
  if (proposal.status !== "pending") {
    return c.json({ error: "already_decided", current_status: proposal.status }, 409);
  }

  const status =
    body.action === "accept" ? "accepted" :
    body.action === "reject" ? "rejected" : "modified";

  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO decisions (id, proposal_id, curator, action, note, decided_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).bind(crypto.randomUUID(), proposalId, body.curator, body.action, body.note ?? null),
    c.env.DB.prepare(
      "UPDATE reclass_proposals SET status = ? WHERE id = ?"
    ).bind(status, proposalId),
    c.env.DB.prepare(
      `INSERT INTO audit_log (id, case_id, actor, action, payload_json, at)
       SELECT ?, v.case_id, ?, ?, json_object('proposal_id', ?, 'note', ?, 'modified_to_tier', ?), datetime('now')
       FROM variants v WHERE v.id = ?`
    ).bind(
      crypto.randomUUID(), body.curator, `proposal_${body.action}`,
      proposalId, body.note ?? null, body.modified_to_tier ?? null, proposal.variant_id
    ),
  ]);

  return c.json({ proposal_id: proposalId, status });
});
