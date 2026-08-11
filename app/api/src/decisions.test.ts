import { describe, expect, it } from "vitest";
import {
  isLive,
  latestByVariant,
  proposalFingerprint,
  resolveTier,
  validateDecision,
  type DecisionRow,
  type ProposalLike,
} from "./decisions";

function proposal(over: Partial<ProposalLike> = {}): ProposalLike {
  return {
    variant_id: "1:100:A:T",
    from_tier: "LP",
    to_tier: "VUS",
    changed_criteria: [
      { criterion: "PM2", fired: false },
      { criterion: "BS1", fired: true },
    ],
    ...over,
  };
}

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    id: "d1",
    case_id: "case-1",
    variant_id: "1:100:A:T",
    action: "accept",
    from_tier: "LP",
    proposed_tier: "VUS",
    final_tier: "VUS",
    curator: "user_abc",
    curator_name: "Dr Rao",
    note: null,
    proposal_fingerprint: proposalFingerprint(proposal()),
    decided_at: "2026-08-11 10:00:00",
    ...over,
  };
}

describe("proposalFingerprint", () => {
  it("is independent of criteria order", () => {
    const a = proposal({ changed_criteria: [{ criterion: "PM2", fired: false }, { criterion: "BS1", fired: true }] });
    const b = proposal({ changed_criteria: [{ criterion: "BS1", fired: true }, { criterion: "PM2", fired: false }] });
    expect(proposalFingerprint(a)).toBe(proposalFingerprint(b));
  });

  it("changes when the tier movement changes", () => {
    expect(proposalFingerprint(proposal())).not.toBe(proposalFingerprint(proposal({ to_tier: "LB" })));
  });

  it("changes when a criterion is added, removed, or flips fired", () => {
    const base = proposalFingerprint(proposal());
    expect(base).not.toBe(proposalFingerprint(proposal({ changed_criteria: [{ criterion: "BS1", fired: true }] })));
    expect(base).not.toBe(
      proposalFingerprint(
        proposal({ changed_criteria: [{ criterion: "PM2", fired: false }, { criterion: "BS1", fired: false }] }),
      ),
    );
  });

  it("treats a missing criteria list as empty rather than throwing", () => {
    expect(() => proposalFingerprint(proposal({ changed_criteria: null }))).not.toThrow();
  });
});

describe("resolveTier — the §4.10 invariant", () => {
  const v = { baseline_tier: "LP", reclass_tier: "VUS" };

  it("reports the baseline tier when a proposal is pending", () => {
    // The engine proposed LP→VUS but nobody signed off. The report must NOT
    // say VUS.
    expect(resolveTier(v, proposal(), null)).toEqual({ tier: "LP", state: "pending" });
  });

  it("reports the proposed tier once accepted", () => {
    expect(resolveTier(v, proposal(), decision())).toEqual({ tier: "VUS", state: "accepted" });
  });

  it("reverts to baseline when rejected", () => {
    const d = decision({ action: "reject", final_tier: "LP", note: "IndiGen AN too low here" });
    expect(resolveTier(v, proposal(), d)).toEqual({ tier: "LP", state: "rejected" });
  });

  it("uses the curator's tier when modified", () => {
    const d = decision({ action: "modify", final_tier: "LB", note: "goes further than the engine proposed" });
    expect(resolveTier(v, proposal(), d)).toEqual({ tier: "LB", state: "modified" });
  });

  it("falls back to baseline when the proposal changed after the decision", () => {
    // Engine re-ran; the proposal now moves LP→LB instead. The old sign-off
    // must not carry over to evidence the curator never saw.
    const rerun = proposal({ to_tier: "LB" });
    expect(resolveTier(v, rerun, decision())).toEqual({ tier: "LP", state: "stale" });
  });

  it("reports the baseline tier when there is no proposal at all", () => {
    expect(resolveTier({ baseline_tier: "P" }, null, null)).toEqual({ tier: "P", state: "no_proposal" });
  });

  it("degrades to an em dash rather than crashing on a tier-less variant", () => {
    expect(resolveTier({}, null, null).tier).toBe("—");
  });
});

describe("isLive", () => {
  it("is false without a decision or without a proposal", () => {
    expect(isLive(proposal(), null)).toBe(false);
    expect(isLive(null, decision())).toBe(false);
  });
});

describe("latestByVariant", () => {
  it("keeps the first row per variant (caller orders newest-first)", () => {
    const newer = decision({ id: "d2", action: "reject", final_tier: "LP", decided_at: "2026-08-11 12:00:00" });
    const older = decision({ id: "d1", decided_at: "2026-08-11 10:00:00" });
    const live = latestByVariant([newer, older]);
    expect(live.get("1:100:A:T")?.id).toBe("d2");
  });

  it("keeps decisions for different variants apart", () => {
    const other = decision({ id: "d9", variant_id: "2:200:G:C" });
    const live = latestByVariant([decision(), other]);
    expect(live.size).toBe(2);
    expect(live.get("2:200:G:C")?.id).toBe("d9");
  });
});

describe("validateDecision", () => {
  it("rejects an unknown action", () => {
    const r = validateDecision({ action: "approve" }, proposal());
    expect(r.ok).toBe(false);
  });

  it("derives the proposed tier on accept, with no note required", () => {
    const r = validateDecision({ action: "accept" }, proposal());
    expect(r).toMatchObject({ ok: true, final_tier: "VUS", note: null });
  });

  it("derives the baseline tier on reject", () => {
    const r = validateDecision({ action: "reject", note: "cohort too small" }, proposal());
    expect(r).toMatchObject({ ok: true, final_tier: "LP" });
  });

  it("requires a note to reject or modify", () => {
    // Disagreeing with the engine without saying why makes the audit trail
    // useless to whoever reads the report.
    expect(validateDecision({ action: "reject" }, proposal()).ok).toBe(false);
    expect(validateDecision({ action: "modify", final_tier: "B" }, proposal()).ok).toBe(false);
    expect(validateDecision({ action: "reject", note: "   " }, proposal()).ok).toBe(false);
  });

  it("requires a valid final_tier to modify", () => {
    expect(validateDecision({ action: "modify", note: "x" }, proposal()).ok).toBe(false);
    expect(validateDecision({ action: "modify", final_tier: "XX", note: "x" }, proposal()).ok).toBe(false);
  });

  it("refuses a modify that just restates the proposal", () => {
    const r = validateDecision({ action: "modify", final_tier: "VUS", note: "same thing" }, proposal());
    expect(r.ok).toBe(false);
  });

  it("trims and caps the note, and keeps the curator name", () => {
    const r = validateDecision(
      { action: "reject", note: `  ${"x".repeat(5000)}  `, curator_name: "  Dr Rao  " },
      proposal(),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.note).toHaveLength(4000);
    expect(r.curator_name).toBe("Dr Rao");
  });

  it("rejects a non-string note", () => {
    expect(validateDecision({ action: "accept", note: 42 }, proposal()).ok).toBe(false);
  });

  it("refuses to accept a proposal with an unrecognized tier", () => {
    expect(validateDecision({ action: "accept" }, proposal({ to_tier: "PATHOGENIC" })).ok).toBe(false);
  });
});
