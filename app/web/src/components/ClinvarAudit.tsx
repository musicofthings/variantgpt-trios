/** ClinVar concordance audit panel for the Workbench.
 *
 *  For each variant in the case that has a ClinVar classification with
 *  ≥2 review stars (multi-submitter no conflicts / expert panel / practice
 *  guideline), compare our baseline_tier against ClinVar's call and bucket
 *  the result as:
 *
 *    - CONCORDANT     : tiers agree (P/LP↔P/LP, B/LB↔B/LB, VUS↔VUS)
 *    - MISSED_PATH    : ClinVar P/LP, we said VUS/LB/B  → we likely under-called
 *    - OVERCALLED     : ClinVar B/LB, we said P/LP      → we likely over-called
 *    - WEAK_DISCORD   : minor mismatch (our VUS ↔ ClinVar LP, etc.)
 *    - RECLASS_AGREE  : our reclassification proposal lines up with ClinVar
 *                       (e.g. we reclass VUS→LB and ClinVar says Benign)
 *
 *  Variants with `clinical_significance = "Conflicting…"` are excluded —
 *  ClinVar itself doesn't have a consensus on those, so there's nothing
 *  to audit against.
 *
 *  This is the cheapest, most actionable validation signal: it tells you
 *  immediately whether a Franklin/VariantGPT divergence is one of *us*
 *  being wrong, or both being wrong, or a known population-AF-driven
 *  reclassification that's expected.
 */
import { useMemo, useState } from "react";
import type { Tier, VariantRow } from "../types";

type Bucket =
  | "CONCORDANT"
  | "MISSED_PATH"
  | "OVERCALLED"
  | "WEAK_DISCORD"
  | "RECLASS_AGREE";

interface AuditedVariant {
  v: VariantRow;
  bucket: Bucket;
  clinvar_call: "P" | "LP" | "VUS" | "LB" | "B";
  cause: string;
}

const TIER_RANK: Record<Tier, number> = { P: 0, LP: 1, VUS: 2, LB: 3, B: 4 };

/** Map a ClinVar `clinical_significance` string onto our Tier vocabulary.
 *  Returns null when the call is conflicting / unclassified / unknown. */
function clinvarToTier(sig: string | undefined): Tier | null {
  if (!sig) return null;
  const s = sig.toLowerCase();
  if (s.includes("conflict")) return null;
  if (s.includes("not provided") || s.includes("uncertain")) return "VUS";
  if (s === "pathogenic" || s.startsWith("pathogenic")) return "P";
  if (s.includes("likely pathogenic")) return "LP";
  if (s === "benign" || s.startsWith("benign")) return "B";
  if (s.includes("likely benign")) return "LB";
  return null;
}

/** Categorise a single variant's audit result. */
function categorise(v: VariantRow, cv: Tier): { bucket: Bucket; cause: string } {
  const ours = v.baseline_tier;
  const reclass = v.reclass?.to ?? null;

  // Exact match (post-reclass too)
  if (ours === cv) return { bucket: "CONCORDANT", cause: "Baseline tier matches ClinVar exactly." };
  if (reclass === cv) {
    return {
      bucket: "RECLASS_AGREE",
      cause: `Reclassification proposal (${v.reclass!.from} → ${v.reclass!.to}) matches ClinVar.`,
    };
  }

  // P/LP family vs B/LB family — the actionable cases
  const oursP = ours === "P" || ours === "LP";
  const cvP = cv === "P" || cv === "LP";
  const cvB = cv === "B" || cv === "LB";

  if (cvP && !oursP) {
    // We missed it.
    const firedP = (v.evidence ?? []).filter((e) => e.fired && e.polarity === "P").length;
    if (firedP === 0) {
      return {
        bucket: "MISSED_PATH",
        cause: "ClinVar calls this Pathogenic but no pathogenic ACMG criterion fired in our analysis. Likely a missing criterion (PS3 / PM3 / PP1 / PP4 not yet implemented) or a population-AF override (BS1 firing on our IndiGenomes track).",
      };
    }
    return {
      bucket: "MISSED_PATH",
      cause: `ClinVar calls this Pathogenic; we fired ${firedP} pathogenic criterion${firedP === 1 ? "" : "ia"} but didn't reach the P/LP threshold. Review the evidence ledger — likely a missing Strong/VeryStrong criterion.`,
    };
  }
  if (cvB && oursP) {
    return {
      bucket: "OVERCALLED",
      cause: "ClinVar calls this Benign/Likely-Benign but we landed in P/LP. Strongest signal of a real disagreement — review the fired pathogenic criteria.",
    };
  }
  // Minor disagreement (P ↔ VUS not-yet, LB ↔ VUS, etc.)
  if (Math.abs(TIER_RANK[ours] - TIER_RANK[cv]) === 1) {
    return {
      bucket: "WEAK_DISCORD",
      cause: `One-tier difference (${ours} vs ${cv}). Usually a single missing/extra Supporting criterion.`,
    };
  }
  return {
    bucket: "WEAK_DISCORD",
    cause: `Different tiers (${ours} vs ${cv}); inspect evidence ledger for divergence.`,
  };
}

export function ClinvarAudit({
  variants, onSelectVariant,
}: {
  variants: VariantRow[];
  onSelectVariant: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [bucketFilter, setBucketFilter] = useState<Bucket | "ALL">("ALL");

  // Audit: variants with ClinVar ≥2★ get categorised; others skipped.
  const audited: AuditedVariant[] = useMemo(() => {
    const out: AuditedVariant[] = [];
    for (const v of variants) {
      if (!v.clinvar) continue;
      if ((v.clinvar.review_stars ?? 0) < 2) continue;
      const cv = clinvarToTier(v.clinvar.clinical_significance);
      if (!cv) continue;
      const { bucket, cause } = categorise(v, cv);
      out.push({ v, bucket, clinvar_call: cv, cause });
    }
    return out;
  }, [variants]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      CONCORDANT: 0, RECLASS_AGREE: 0, WEAK_DISCORD: 0, MISSED_PATH: 0, OVERCALLED: 0,
    };
    for (const a of audited) c[a.bucket] += 1;
    return c;
  }, [audited]);

  // No ≥2★ ClinVar variants in this case → audit isn't useful; hide.
  if (audited.length === 0) return null;

  const concordant = counts.CONCORDANT + counts.RECLASS_AGREE;
  const concordanceRate = (concordant / audited.length) * 100;

  const filtered = bucketFilter === "ALL"
    ? audited
    : audited.filter((a) => a.bucket === bucketFilter);

  return (
    <div
      className="card"
      style={{
        marginBottom: 12,
        padding: "10px 14px",
        border: "1px solid var(--rule)",
        background: "var(--surface-sunken)",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          cursor: "pointer", userSelect: "none",
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        <strong>ClinVar audit</strong>
        <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          {audited.length} variant{audited.length === 1 ? "" : "s"} with ≥2★ ClinVar classification
        </span>
        <span
          className="mono"
          style={{ fontSize: 12, color: concordanceRate > 85 ? "var(--success, #2c8462)" : "var(--rust, #b04a2a)" }}
        >
          {concordanceRate.toFixed(0)}% concordant
        </span>
        <BucketChip n={counts.CONCORDANT} label="match" tone="ok" />
        <BucketChip n={counts.RECLASS_AGREE} label="reclass→agree" tone="ok" />
        <BucketChip n={counts.WEAK_DISCORD} label="±1 tier" tone="warn" />
        <BucketChip n={counts.MISSED_PATH} label="missed P/LP" tone="bad" />
        <BucketChip n={counts.OVERCALLED} label="over-called" tone="bad" />
        <span style={{ marginLeft: "auto", color: "var(--ink-soft)", fontSize: 12 }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {expanded ? (
        <div style={{ marginTop: 10 }}>
          {/* Quick filter strip */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", fontSize: 12 }}>
            {(["ALL", "MISSED_PATH", "OVERCALLED", "WEAK_DISCORD", "CONCORDANT", "RECLASS_AGREE"] as const).map((b) => (
              <button
                key={b}
                onClick={(e) => { e.stopPropagation(); setBucketFilter(b); }}
                disabled={b !== "ALL" && counts[b as Bucket] === 0}
                style={{
                  padding: "2px 10px", borderRadius: 999,
                  border: "1px solid var(--rule)",
                  background: bucketFilter === b ? "var(--primary-soft)" : "var(--paper)",
                  fontSize: 11,
                }}
              >
                {b === "ALL" ? `All (${audited.length})` : `${b.replace("_", " ").toLowerCase()} (${counts[b as Bucket]})`}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>No variants in this bucket.</p>
          ) : (
            <table className="table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Gene · HGVS</th>
                  <th>Our tier</th>
                  <th>ClinVar (≥2★)</th>
                  <th>Bucket</th>
                  <th>Likely cause</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 50).map(({ v, bucket, clinvar_call, cause }) => (
                  <tr
                    key={v.id}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => { e.stopPropagation(); onSelectVariant(v.id); }}
                  >
                    <td className="mono">
                      <strong>{v.gene}</strong> {v.hgvs_c}
                      {v.hgvs_p ? <span style={{ color: "var(--ink-soft)" }}> {v.hgvs_p}</span> : null}
                    </td>
                    <td>{v.baseline_tier}{v.reclass ? <span style={{ color: "var(--ink-soft)" }}> → {v.reclass.to}</span> : null}</td>
                    <td>{clinvar_call} <span style={{ color: "var(--ink-soft)" }}>({v.clinvar?.review_stars}★)</span></td>
                    <td><BucketLabel bucket={bucket} /></td>
                    <td style={{ color: "var(--ink-soft)", maxWidth: 360 }}>{cause}</td>
                  </tr>
                ))}
                {filtered.length > 50 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--ink-soft)" }}>
                    + {filtered.length - 50} more …
                  </td></tr>
                ) : null}
              </tbody>
            </table>
          )}

          <p style={{ marginTop: 10, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Only variants with ClinVar review stars ≥ 2 (multi-submitter no conflicts /
            expert panel / practice guideline) are audited — single-submitter and
            no-criteria entries are excluded to avoid scoring noise. Click any row to
            open the variant in the workbench drawer for an evidence-ledger review.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function BucketChip({ n, label, tone }: { n: number; label: string; tone: "ok" | "warn" | "bad" }) {
  if (n === 0) return null;
  const color =
    tone === "ok" ? "var(--success, #2c8462)"
    : tone === "warn" ? "var(--ink-soft)"
    : "var(--rust, #b04a2a)";
  return (
    <span
      className="mono"
      style={{
        fontSize: 11, padding: "1px 8px",
        borderRadius: 999, border: `1px solid ${color}`, color,
      }}
    >
      {n} {label}
    </span>
  );
}

function BucketLabel({ bucket }: { bucket: Bucket }) {
  const labels: Record<Bucket, { text: string; color: string }> = {
    CONCORDANT:    { text: "match",           color: "var(--success, #2c8462)" },
    RECLASS_AGREE: { text: "reclass→agree",   color: "var(--success, #2c8462)" },
    WEAK_DISCORD:  { text: "±1 tier",         color: "var(--ink-soft)" },
    MISSED_PATH:   { text: "missed P/LP",     color: "var(--rust, #b04a2a)" },
    OVERCALLED:    { text: "over-called",     color: "var(--rust, #b04a2a)" },
  };
  const l = labels[bucket];
  return (
    <span style={{ color: l.color, fontSize: 11, fontWeight: 500 }}>{l.text}</span>
  );
}
