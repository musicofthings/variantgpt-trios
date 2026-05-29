/** Shared phenotype-relevance helpers + UI, used by both the Workbench
 *  (read-only % column) and the Analysis Workbench (algorithm selector +
 *  per-term breakdown). The engine precomputes all three algorithms per
 *  variant, so switching algorithm here is a pure display toggle. */
import type { PhenotypeAlgorithm, PhenotypeScore, VariantRow } from "./types";

/** Default algorithm shown in the main Workbench column. Phrank balances
 *  specificity (information content) against coverage breadth. */
export const DEFAULT_PHENO_ALGO: PhenotypeAlgorithm = "phrank";

export const PHENO_ALGORITHMS: { id: PhenotypeAlgorithm; label: string; blurb: string }[] = [
  {
    id: "phrank",
    label: "Phrank",
    blurb:
      "Sums information content over the HPO ancestor terms the gene and patient share. Rewards specific (rare) shared phenotypes; tolerant of ontology distance.",
  },
  {
    id: "resnik",
    label: "Resnik (BMA)",
    blurb:
      "Best-match-average semantic similarity: each patient term is matched to the gene's closest associated term over the HPO DAG, then averaged.",
  },
  {
    id: "coverage",
    label: "Coverage",
    blurb:
      "Fraction of the patient's HPO terms the gene is directly associated with. Exact matches only — no ontology inference. Most conservative.",
  },
];

export function phenoScore(v: VariantRow, algo: PhenotypeAlgorithm): PhenotypeScore | null {
  const rel = v.phenotype_relevance;
  if (!rel) return null;
  return rel[algo] ?? null;
}

/** Numeric percent for sorting; -1 when the variant has no phenotype data so
 *  unscored rows sink to the bottom of a descending sort. */
export function phenoPercent(v: VariantRow, algo: PhenotypeAlgorithm): number {
  return phenoScore(v, algo)?.percent ?? -1;
}

/** Color ramp: strong phenotype match → primary, weak → muted. */
function relColor(pct: number): string {
  if (pct >= 70) return "var(--ok, #1a7f5a)";
  if (pct >= 40) return "var(--primary, #2563eb)";
  if (pct > 0) return "var(--warn, #b45309)";
  return "var(--ink-soft, #888)";
}

/** Compact inline relevance bar + percent label for table cells. */
export function PhenotypeBar({
  percent,
  width = 54,
}: {
  percent: number | null;
  width?: number;
}) {
  if (percent === null || percent < 0) {
    return <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>—</span>;
  }
  const pct = Math.max(0, Math.min(100, percent));
  const color = relColor(pct);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        aria-hidden
        style={{
          width,
          height: 6,
          borderRadius: 3,
          background: "var(--line, #e5e7eb)",
          overflow: "hidden",
          flex: "0 0 auto",
        }}
      >
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: color }} />
      </span>
      <span className="mono" style={{ fontSize: 12, color, minWidth: 30, textAlign: "right" }}>
        {pct.toFixed(0)}%
      </span>
    </span>
  );
}
