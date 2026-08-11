-- Curator sign-off on South-Asian reclassification proposals (PRD §4.10).
--
-- The invariant: reclassification NEVER auto-commits. reclassify.py emits every
-- ReclassProposal in `pending` status, and a proposed tier only becomes the
-- reported classification once a human curator records a decision. Until this
-- migration there was nowhere to record one — the 0001 `reclass_proposals` /
-- `decisions` tables were designed for a D1-resident variant table that the
-- pipeline never populates (the real variant data lives in R2 `case.json`), so
-- they've sat empty and their routes stayed unmounted.
--
-- This table keys decisions the way the data actually exists: (case_id,
-- variant_id) against the case.json emission, with no FK into `variants`.
--
-- APPEND-ONLY. No UPDATE, no DELETE in any code path. A curator changing their
-- mind inserts a NEW row; the row with the highest decided_at (id breaks ties)
-- is the live decision and every earlier row remains as audit history.
--
-- `proposal_fingerprint` pins the decision to the exact proposal that was
-- reviewed (from_tier, to_tier and the changed-criteria set). If the engine is
-- re-run and the proposal for that variant comes back different, the stored
-- fingerprint no longer matches and the API reports the decision as STALE —
-- it stops counting as sign-off and the variant returns to pending review.
-- Without this, a rerun could silently inherit approval for evidence nobody saw.
CREATE TABLE IF NOT EXISTS reclass_decisions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    action TEXT NOT NULL,               -- accept|reject|modify
    from_tier TEXT NOT NULL,            -- proposal's baseline tier, snapshotted
    proposed_tier TEXT NOT NULL,        -- proposal's target tier, snapshotted
    final_tier TEXT NOT NULL,           -- what the curator settled on (reported)
    curator TEXT NOT NULL,              -- Clerk `sub` of the deciding user
    curator_name TEXT,                  -- display name at decision time, if sent
    note TEXT,                          -- free-text rationale
    proposal_fingerprint TEXT NOT NULL,
    decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Live-decision lookup: newest row per variant within a case.
CREATE INDEX IF NOT EXISTS idx_reclass_decisions_case
    ON reclass_decisions(case_id, variant_id, decided_at DESC);
