/**
 * Curator sign-off on reclassification proposals (PRD §4.10).
 *
 * The load-bearing invariant this module implements: **a reclassification
 * proposal never becomes the reported classification on its own.** The engine
 * emits every proposal `pending` (reclassify.py); a proposed tier only takes
 * effect once a human curator records an explicit decision, and that decision
 * is pinned to the exact evidence the curator saw.
 *
 * Everything here is pure — no D1, no fetch — so the rules are unit-tested
 * directly. `routes/api.ts` owns persistence, `report.ts` consumes the same
 * `resolveTier()` so screen and paper can never disagree about what tier a
 * variant carries.
 */

export type Tier = "P" | "LP" | "VUS" | "LB" | "B";
export const TIERS: readonly Tier[] = ["P", "LP", "VUS", "LB", "B"];

export function isTier(x: unknown): x is Tier {
  return typeof x === "string" && (TIERS as readonly string[]).includes(x);
}

export type DecisionAction = "accept" | "reject" | "modify";
const ACTIONS: readonly DecisionAction[] = ["accept", "reject", "modify"];

export function isAction(x: unknown): x is DecisionAction {
  return typeof x === "string" && (ACTIONS as readonly string[]).includes(x);
}

/** A reclassification proposal as it appears in case.json (`proposals[]`). */
export interface ProposalLike {
  variant_id: string;
  from_tier: string;
  to_tier: string;
  changed_criteria?: Array<{ criterion: string; fired?: boolean }> | null;
}

/** One decision row, exactly as stored in D1 (`reclass_decisions`). */
export interface DecisionRow {
  id: string;
  case_id: string;
  variant_id: string;
  action: DecisionAction;
  from_tier: string;
  proposed_tier: string;
  final_tier: string;
  curator: string;
  curator_name: string | null;
  note: string | null;
  proposal_fingerprint: string;
  decided_at: string;
}

/** A decision as served to clients — the stored row plus whether it still
 *  matches the proposal currently in case.json. */
export interface DecisionRecord extends DecisionRow {
  /** True when the engine re-ran and the proposal changed underneath this
   *  decision. A stale decision is history, not sign-off. */
  stale: boolean;
}

/**
 * Identity of the *evidence* a curator signed off on: the tier movement plus
 * the set of criteria that changed. Order-independent, so a rerun that emits
 * the same criteria in a different order is still the same proposal.
 *
 * If a rerun changes the movement or the criteria, the fingerprint changes and
 * the prior decision goes stale — the variant returns to pending review rather
 * than silently inheriting approval for evidence nobody looked at.
 */
export function proposalFingerprint(p: ProposalLike): string {
  const crit = (p.changed_criteria ?? [])
    .map((c) => `${c.criterion}:${c.fired ? 1 : 0}`)
    .sort()
    .join(",");
  return `${p.from_tier}>${p.to_tier}|${crit}`;
}

/** What a variant's classification state is, once proposals and decisions are
 *  reconciled. Drives both the workbench badge and the report. */
export type TierState =
  | "no_proposal"  // engine never proposed a change
  | "pending"      // proposed, awaiting a curator
  | "stale"        // decided, but the proposal has since changed — re-review
  | "accepted"
  | "modified"
  | "rejected";

/** True when this decision is live sign-off for this proposal. */
export function isLive(proposal: ProposalLike | null | undefined, d: DecisionRow | null | undefined): boolean {
  if (!d || !proposal) return false;
  return d.proposal_fingerprint === proposalFingerprint(proposal);
}

/**
 * The single source of truth for "what tier does this variant carry?".
 *
 * A pending, stale, or rejected proposal all report the BASELINE tier — the
 * engine's South-Asian proposal is never what the report says until a curator
 * accepts (or modifies) it. This is the §4.10 invariant in one function.
 */
export function resolveTier(
  v: { baseline_tier?: string | null; reclass_tier?: string | null },
  proposal?: ProposalLike | null,
  decision?: DecisionRow | null,
): { tier: string; state: TierState } {
  const baseline = v.baseline_tier ?? v.reclass_tier ?? "—";
  if (!proposal) return { tier: baseline, state: "no_proposal" };
  if (!decision) return { tier: baseline, state: "pending" };
  if (!isLive(proposal, decision)) return { tier: baseline, state: "stale" };
  const state: TierState =
    decision.action === "accept" ? "accepted"
    : decision.action === "modify" ? "modified"
    : "rejected";
  return { tier: decision.final_tier, state };
}

/**
 * Collapse an append-only decision history to the live decision per variant.
 * `rows` MUST be newest-first (the SQL orders `decided_at DESC, rowid DESC`,
 * since `datetime('now')` only has second resolution and can tie).
 */
export function latestByVariant(rows: DecisionRow[]): Map<string, DecisionRow> {
  const out = new Map<string, DecisionRow>();
  for (const r of rows) if (!out.has(r.variant_id)) out.set(r.variant_id, r);
  return out;
}

export interface DecisionInput {
  action: unknown;
  final_tier?: unknown;
  note?: unknown;
  curator_name?: unknown;
}

export type ValidationResult =
  | { ok: true; action: DecisionAction; final_tier: Tier; note: string | null; curator_name: string | null }
  | { ok: false; error: string };

const MAX_NOTE = 4000;

/**
 * Validate a decision request against the live proposal and derive the tier the
 * report will carry.
 *
 * - accept → the proposed tier
 * - reject → the baseline tier (the proposal is declined, nothing moves)
 * - modify → an explicit curator-supplied tier, which must differ from the
 *   proposal (otherwise it's an accept, and should be recorded as one)
 */
export function validateDecision(input: DecisionInput, proposal: ProposalLike): ValidationResult {
  if (!isAction(input.action)) {
    return { ok: false, error: "action must be one of: accept, reject, modify" };
  }
  const action = input.action;

  let final_tier: Tier;
  if (action === "accept") {
    if (!isTier(proposal.to_tier)) return { ok: false, error: `proposal has an unrecognized to_tier "${proposal.to_tier}"` };
    final_tier = proposal.to_tier;
  } else if (action === "reject") {
    if (!isTier(proposal.from_tier)) return { ok: false, error: `proposal has an unrecognized from_tier "${proposal.from_tier}"` };
    final_tier = proposal.from_tier;
  } else {
    if (!isTier(input.final_tier)) {
      return { ok: false, error: `modify requires final_tier, one of: ${TIERS.join(", ")}` };
    }
    if (input.final_tier === proposal.to_tier) {
      return { ok: false, error: "modify must choose a tier other than the proposed one — record an accept instead" };
    }
    final_tier = input.final_tier;
  }

  if (input.note != null && typeof input.note !== "string") {
    return { ok: false, error: "note must be a string" };
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, MAX_NOTE) : "";
  // A rejection or a manual override is a clinical judgement call that
  // disagrees with the engine — it has to say why, or the audit trail is
  // worthless to whoever reads the report later.
  if (!note && action !== "accept") {
    return { ok: false, error: `a note is required when you ${action} a proposal` };
  }

  const curator_name =
    typeof input.curator_name === "string" && input.curator_name.trim()
      ? input.curator_name.trim().slice(0, 200)
      : null;

  return { ok: true, action, final_tier, note: note || null, curator_name };
}
