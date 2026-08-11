/**
 * Curator sign-off on a South-Asian reclassification proposal (PRD §4.10).
 *
 * The invariant this UI serves: the engine's proposal is a *proposal*. Until a
 * curator acts on it here, the variant keeps its baseline tier — on screen, in
 * the report, and in the archival PDF. The panel therefore always states which
 * tier is currently being reported, not just what was proposed.
 *
 * Decisions are append-only: changing your mind records a NEW decision and the
 * previous one stays in the audit trail. Nothing is ever edited or deleted.
 */
import { useState } from "react";
import {
  TIER_STATE_LABEL, modifiableTiers, tierForVariant,
  type DecisionAction, type DecisionRecord, type UseDecisions,
} from "../decisions";
import type { ReclassProposal, Tier, VariantRow } from "../types";

const PANEL: React.CSSProperties = {
  marginTop: 16,
  background: "rgba(180,84,30,0.04)",
  borderColor: "rgba(180,84,30,0.25)",
  padding: 16,
};

function stateTone(state: string): { fg: string; bg: string } {
  switch (state) {
    case "accepted":
    case "modified":
      return { fg: "var(--success, #2c8462)", bg: "rgba(44,132,98,0.10)" };
    case "rejected":
      return { fg: "var(--ink-soft)", bg: "var(--surface-sunken, #f4f4f4)" };
    case "stale":
      return { fg: "var(--rust, #b04a2a)", bg: "rgba(176,74,42,0.10)" };
    default: // pending
      return { fg: "#b07d2b", bg: "rgba(176,125,43,0.10)" };
  }
}

export function DecisionStatusChip({ state }: { state: string }) {
  if (state === "no_proposal") return null;
  const tone = stateTone(state);
  return (
    <span
      style={{
        fontSize: 10, padding: "1px 6px", borderRadius: 999, whiteSpace: "nowrap",
        border: `1px solid ${tone.fg}`, color: tone.fg, background: tone.bg,
      }}
    >
      {TIER_STATE_LABEL[state as keyof typeof TIER_STATE_LABEL] || state}
    </span>
  );
}

function RecordedDecision({ d }: { d: DecisionRecord }) {
  const verb = d.action === "accept" ? "Accepted" : d.action === "reject" ? "Rejected" : "Modified";
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      <strong>{verb}</strong> by{" "}
      <span className="mono">{d.curator_name ?? d.curator}</span> on{" "}
      <span className="mono">{d.decided_at}</span>
      {d.note ? (
        <div style={{ marginTop: 4, color: "var(--ink-soft)", fontStyle: "italic" }}>“{d.note}”</div>
      ) : null}
    </div>
  );
}

export function ReclassDecision({
  variant,
  decisions,
  curatorName,
}: {
  variant: VariantRow;
  decisions: UseDecisions;
  /** Display name recorded alongside the decision (Clerk user, when signed in). */
  curatorName?: string;
}) {
  const proposal: ReclassProposal | null | undefined = variant.reclass;
  const decision = decisions.byVariant.get(variant.id);
  const [draft, setDraft] = useState<DecisionAction | null>(null);
  const [note, setNote] = useState("");
  const [modifyTier, setModifyTier] = useState<Tier | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!proposal) return null;

  const { tier, state } = tierForVariant(variant, true, decision);
  const live = state === "accepted" || state === "modified" || state === "rejected";
  const tone = stateTone(state);

  async function submit(action: DecisionAction) {
    setBusy(true);
    setErr(null);
    try {
      await decisions.record({
        variant_id: variant.id,
        action,
        final_tier: action === "modify" ? (modifyTier as Tier) : undefined,
        note: note.trim() || undefined,
        curator_name: curatorName,
      });
      setDraft(null);
      setNote("");
      setModifyTier("");
    } catch (e) {
      // Server-side validation messages are user-facing ("a note is required
      // when you reject a proposal") — show them verbatim.
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={PANEL}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong>
          {proposal.from} → {proposal.to}
        </strong>
        <span style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)" }}>Δ {proposal.delta}</span>
        <DecisionStatusChip state={state} />
      </div>

      <div style={{ marginTop: 8, fontSize: 13 }}>
        Changed: <span className="mono">{proposal.criteria.join(", ")}</span>
      </div>

      {/* Always say what's actually being reported. A pending proposal that
          looks like a classification is the exact failure mode §4.10 exists
          to prevent. */}
      <div
        style={{
          marginTop: 12, padding: "6px 10px", borderRadius: 6,
          background: tone.bg, color: tone.fg, fontSize: 12,
        }}
      >
        Reported classification: <strong className="mono">{tier}</strong>
        {!live ? " — this proposal is not applied until you decide." : null}
      </div>

      {state === "stale" ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--rust, #b04a2a)" }}>
          The engine re-ran and this proposal changed after it was decided. The earlier decision
          is kept in the audit trail but no longer counts as sign-off — please review again.
        </div>
      ) : null}

      {live && decision ? (
        <div style={{ marginTop: 12 }}>
          <RecordedDecision d={decision} />
        </div>
      ) : null}

      {/* Action row. Re-deciding is allowed — it appends, never overwrites. */}
      {draft === null ? (
        <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="primary" disabled={busy} onClick={() => submit("accept")}>
            Accept
          </button>
          <button disabled={busy} onClick={() => setDraft("reject")}>Reject…</button>
          <button disabled={busy} onClick={() => setDraft("modify")}>Modify…</button>
        </div>
      ) : (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {draft === "modify" ? (
            <label style={{ fontSize: 13 }}>
              Final classification
              <select
                value={modifyTier}
                onChange={(e) => setModifyTier(e.target.value as Tier)}
                style={{ marginLeft: 8, padding: "4px 8px" }}
              >
                <option value="">Choose…</option>
                {modifiableTiers({ variant_id: variant.id, from_tier: proposal.from, to_tier: proposal.to }).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label style={{ fontSize: 13 }}>
            Rationale <span style={{ color: "var(--ink-soft)" }}>(required)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={
                draft === "reject"
                  ? "Why the South-Asian frequency evidence doesn't hold here…"
                  : "Why the final classification differs from the proposal…"
              }
              style={{ width: "100%", marginTop: 4, padding: 8, fontFamily: "inherit" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="primary"
              disabled={busy || !note.trim() || (draft === "modify" && !modifyTier)}
              onClick={() => submit(draft)}
            >
              {busy ? "Recording…" : `Record ${draft}`}
            </button>
            <button disabled={busy} onClick={() => { setDraft(null); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {err ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--rust, #b04a2a)" }}>{err}</div>
      ) : null}

      <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)" }}>
        Decisions are append-only and audit-logged. Re-deciding records a new entry; the previous
        one is retained.
      </div>
    </div>
  );
}
