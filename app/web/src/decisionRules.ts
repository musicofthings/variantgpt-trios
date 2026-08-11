/**
 * Curator sign-off on reclassification proposals — client side (PRD §4.10).
 *
 * The invariant: a South-Asian reclassification proposal NEVER becomes the
 * variant's classification on its own. The engine emits every proposal
 * `pending`; the tier only moves once a curator records an explicit decision,
 * and that decision is pinned to the exact evidence they reviewed.
 *
 * The rules below (fingerprint / resolveTier / validate) intentionally mirror
 * `app/api/src/decisions.ts` — that module is the source of truth and the two
 * MUST agree, or the workbench and the signed report will disagree about what
 * tier a variant carries. Any change here needs the same change there. The
 * fingerprint format in particular is a wire contract: it's computed on the
 * server at write time and compared against locally-computed values.
 *
 * This module is deliberately PURE — no fetch, no `import.meta.env`, no React.
 * `vite.devCaseApi.ts` imports it from inside the Vite config (plain Node), so
 * local dev enforces exactly the same rules as the Worker. The HTTP client
 * lives next door in `decisions.ts`.
 */
import type { Tier } from "./types";

export const TIERS: readonly Tier[] = ["P", "LP", "VUS", "LB", "B"];

export function isTier(x: unknown): x is Tier {
  return typeof x === "string" && (TIERS as readonly string[]).includes(x);
}

export type DecisionAction = "accept" | "reject" | "modify";
const ACTIONS: readonly DecisionAction[] = ["accept", "reject", "modify"];

export function isAction(x: unknown): x is DecisionAction {
  return typeof x === "string" && (ACTIONS as readonly string[]).includes(x);
}

/** A proposal as it appears in case.json (`proposals[]`). */
export interface ProposalLike {
  variant_id: string;
  from_tier: string;
  to_tier: string;
  changed_criteria?: Array<{ criterion: string; fired?: boolean }> | null;
}

/** One recorded decision, as served by GET /api/cases/:id/decisions. */
export interface DecisionRecord {
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
  /** Server-computed: the proposal changed after this decision was recorded,
   *  so it no longer counts as sign-off. */
  stale: boolean;
}

export interface DecisionsPayload {
  /** Live decision per variant (newest wins). */
  decisions: DecisionRecord[];
  /** Every decision ever recorded for the case, newest first. */
  history: DecisionRecord[];
  /** Variant ids with a proposal but no live sign-off. */
  pending: string[];
  proposal_count: number;
}

/** Identity of the evidence a curator signed off on. Order-independent.
 *  MUST match app/api/src/decisions.ts::proposalFingerprint. */
export function proposalFingerprint(p: ProposalLike): string {
  const crit = (p.changed_criteria ?? [])
    .map((c) => `${c.criterion}:${c.fired ? 1 : 0}`)
    .sort()
    .join(",");
  return `${p.from_tier}>${p.to_tier}|${crit}`;
}

export type TierState =
  | "no_proposal" | "pending" | "stale" | "accepted" | "modified" | "rejected";

export const TIER_STATE_LABEL: Record<TierState, string> = {
  no_proposal: "",
  pending: "Awaiting review",
  stale: "Needs re-review",
  accepted: "Accepted",
  modified: "Modified",
  rejected: "Rejected",
};

export function isLive(
  proposal: ProposalLike | null | undefined,
  d: { proposal_fingerprint: string } | null | undefined,
): boolean {
  if (!d || !proposal) return false;
  return d.proposal_fingerprint === proposalFingerprint(proposal);
}

/**
 * What tier a variant actually carries. Pending, stale, and rejected proposals
 * all report the BASELINE tier — this function is the §4.10 invariant.
 */
export function resolveTier(
  v: { baseline_tier?: string | null; reclass_tier?: string | null },
  proposal?: ProposalLike | null,
  decision?: DecisionRecord | null,
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
 * Client-side tier resolution.
 *
 * Same rule as resolveTier, but it trusts the server's `stale` flag instead of
 * recomputing the fingerprint. The fingerprint is a server-side wire contract —
 * the browser has no business re-deriving it, and this way a UI that lags the
 * server's format still resolves tiers correctly.
 */
export function tierForVariant(
  v: { baseline_tier?: string | null; reclass_tier?: string | null },
  hasProposal: boolean,
  decision?: DecisionRecord | null,
): { tier: string; state: TierState } {
  const baseline = v.baseline_tier ?? v.reclass_tier ?? "—";
  if (!hasProposal) return { tier: baseline, state: "no_proposal" };
  if (!decision) return { tier: baseline, state: "pending" };
  if (decision.stale) return { tier: baseline, state: "stale" };
  const state: TierState =
    decision.action === "accept" ? "accepted"
    : decision.action === "modify" ? "modified"
    : "rejected";
  return { tier: decision.final_tier, state };
}

/** Collapse append-only history to the live decision per variant.
 *  `rows` MUST be newest-first. */
export function latestByVariant<T extends { variant_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) if (!out.has(r.variant_id)) out.set(r.variant_id, r);
  return out;
}

// ───────────────────────── validation (shared with the dev shim) ─────────────────────────

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

/** MUST match app/api/src/decisions.ts::validateDecision. */
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
  if (!note && action !== "accept") {
    return { ok: false, error: `a note is required when you ${action} a proposal` };
  }

  const curator_name =
    typeof input.curator_name === "string" && input.curator_name.trim()
      ? input.curator_name.trim().slice(0, 200)
      : null;

  return { ok: true, action, final_tier, note: note || null, curator_name };
}

/** Tiers a curator may pick when overriding a proposal — everything except the
 *  one the engine already proposed (choosing that IS an accept). */
export function modifiableTiers(proposal: ProposalLike): Tier[] {
  return TIERS.filter((t) => t !== proposal.to_tier);
}
