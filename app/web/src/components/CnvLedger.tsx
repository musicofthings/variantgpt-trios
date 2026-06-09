/** CNV evidence ledger — the ClinGen/ACMG 2019 (Riggs 2020) scoring breakdown
 *  for a structural variant. Each line is a section contribution (signed score);
 *  the running total maps to the five-tier classification. The transparency
 *  analogue of the SNV EvidenceLedger, but for dosage-sensitivity scoring. */
import type { CnvEvidence, Tier } from "../types";

const SECTION_LABEL: Record<string, string> = {
  "1A": "Genomic content — contains coding/functional elements",
  "1B": "Genomic content — no coding/functional elements",
  "2A": "Overlap with established dosage-sensitive gene/region (complete)",
  "2C-E": "Overlap with established dosage-sensitive gene (partial)",
  "2F": "Overlap with established benign / dosage-insensitive region",
  "2H": "Predicted haploinsufficient gene (high pLI)",
  "3": "Number of protein-coding genes involved",
  "4": "Reported case / literature evidence",
  "5A": "Inheritance — de novo",
  "5": "Inheritance",
};

function fmt(score: number): string {
  return (score > 0 ? "+" : "") + score.toFixed(2);
}

export function CnvLedger({ evidence, score, tier }: { evidence: CnvEvidence[]; score: number; tier?: Tier | null }) {
  const applied = evidence.filter((e) => e.applied);
  return (
    <div className="cnv-ledger" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>ClinGen CNV score</strong>
        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(score)}</span>
        {tier ? <span className="mono" style={{ fontSize: 12, color: "var(--ink-soft)" }}>→ {tier}</span> : null}
        <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
          (≥0.99 P · 0.90 LP · ±0.89 VUS · −0.90 LB · ≤−0.99 B)
        </span>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
        {evidence.map((e, i) => (
          <li
            key={`${e.section}-${i}`}
            style={{
              display: "grid", gridTemplateColumns: "52px 56px 1fr", gap: 8, alignItems: "baseline",
              padding: "4px 8px", borderRadius: 6,
              background: e.applied ? "var(--surface-sunken, #f6f6f6)" : "transparent",
              opacity: e.applied ? 1 : 0.5, fontSize: 12,
            }}
          >
            <span className="mono" style={{ fontWeight: 600 }}>{e.section}</span>
            <span
              className="mono"
              style={{
                textAlign: "right",
                color: !e.applied ? "var(--ink-soft)" : e.score > 0 ? "var(--rust, #b04a2a)" : e.score < 0 ? "var(--success, #2c8462)" : "var(--ink-soft)",
              }}
            >
              {e.applied ? fmt(e.score) : "—"}
            </span>
            <span>
              <span>{e.detail || SECTION_LABEL[e.section] || e.section}</span>
              {e.source ? <span style={{ color: "var(--ink-soft)" }}> · {e.source}</span> : null}
            </span>
          </li>
        ))}
        {applied.length === 0 ? (
          <li style={{ fontSize: 12, color: "var(--ink-soft)" }}>No scoring sections applied.</li>
        ) : null}
      </ul>
    </div>
  );
}
