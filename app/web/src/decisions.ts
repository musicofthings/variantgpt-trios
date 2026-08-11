/**
 * Curator sign-off — HTTP client (PRD §4.10).
 *
 * The rules themselves live in `decisionRules.ts` (pure, also imported by the
 * Vite dev API shim); this module only talks to the Worker. Re-exports the
 * rules so components have one import.
 */
import { useCallback, useEffect, useState } from "react";
import { api, apiFetch } from "./apiBase";
import type { Tier } from "./types";
import { latestByVariant, type DecisionAction, type DecisionRecord, type DecisionsPayload } from "./decisionRules";

export * from "./decisionRules";

export async function fetchDecisions(caseId: string): Promise<DecisionsPayload> {
  const r = await apiFetch(api(`/cases/${caseId}/decisions`));
  if (!r.ok) throw new Error(`decisions fetch failed (${r.status})`);
  return (await r.json()) as DecisionsPayload;
}

export async function postDecision(
  caseId: string,
  body: {
    variant_id: string;
    action: DecisionAction;
    final_tier?: Tier;
    note?: string;
    curator_name?: string;
  },
): Promise<DecisionRecord> {
  const r = await apiFetch(api(`/cases/${caseId}/decisions`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await r.json().catch(() => ({}))) as { decision?: DecisionRecord; error?: string };
  // Surface the Worker's own message ("a note is required when you reject a
  // proposal") rather than a bare status code — these are user-facing.
  if (!r.ok) throw new Error(payload.error ?? `decision failed (${r.status})`);
  if (!payload.decision) throw new Error("malformed decision response");
  return payload.decision;
}

export interface UseDecisions {
  /** Live decision per variant id (stale ones included — check `.stale`). */
  byVariant: Map<string, DecisionRecord>;
  /** Variant ids with a proposal and no live sign-off. */
  pending: Set<string>;
  history: DecisionRecord[];
  loading: boolean;
  error: string | null;
  /** Record a decision and fold the result into local state. Throws on
   *  validation failure so the caller can surface the server's message. */
  record: (body: Parameters<typeof postDecision>[1]) => Promise<DecisionRecord>;
  reload: () => void;
}

/**
 * Curator decisions for a case. Deliberately NOT cached across mounts — a
 * decision is the thing this screen exists to change, so a stale read is worse
 * than a re-fetch.
 */
export function useDecisions(caseId?: string): UseDecisions {
  const [payload, setPayload] = useState<DecisionsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!caseId) {
      setPayload(null);
      return;
    }
    let cancelled = false;
    fetchDecisions(caseId)
      .then((p) => !cancelled && setPayload(p))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [caseId, nonce]);

  const record = useCallback(
    async (body: Parameters<typeof postDecision>[1]) => {
      if (!caseId) throw new Error("no case selected");
      const decision = await postDecision(caseId, body);
      // Fold in locally so the drawer updates without a round-trip; the new
      // row goes to the front because history is newest-first.
      setPayload((prev) => {
        const history = [decision, ...(prev?.history ?? [])];
        return {
          decisions: [...latestByVariant(history).values()],
          history,
          pending: (prev?.pending ?? []).filter((id) => id !== decision.variant_id),
          proposal_count: prev?.proposal_count ?? 0,
        };
      });
      setError(null);
      return decision;
    },
    [caseId],
  );

  return {
    byVariant: new Map((payload?.decisions ?? []).map((d) => [d.variant_id, d])),
    pending: new Set(payload?.pending ?? []),
    history: payload?.history ?? [],
    loading: !payload && !error && !!caseId,
    error,
    record,
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}
