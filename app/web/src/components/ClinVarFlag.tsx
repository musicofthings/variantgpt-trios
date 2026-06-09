/** ClinVar concordance flag — renders the engine-vs-ClinVar reconciliation the
 *  engine attaches to a sequence variant or structural variant (PRD §4.5).
 *
 *  The engine never lets ClinVar override its computed tier (ClinGen retired
 *  PP5/BP6); this badge simply surfaces the disagreement so a curator sees it.
 *  Discordant calls (engine pathogenic vs ≥2★ ClinVar benign, or vice-versa)
 *  are loud; concordant/uninformative states are quiet. */
import type { ClinVarConcordance } from "../types";

export function ClinVarFlag({
  concordance,
  compact = false,
}: {
  concordance?: ClinVarConcordance | null;
  compact?: boolean;
}) {
  if (!concordance) return null;
  const { status } = concordance;
  // Quiet states don't earn screen space in compact (inline) mode.
  if (compact && status !== "discordant") return null;

  const tone =
    status === "discordant"
      ? { bg: "rgba(176,74,42,0.10)", border: "var(--rust, #b04a2a)", fg: "var(--rust, #b04a2a)", label: "ClinVar discordant" }
      : status === "concordant"
      ? { bg: "rgba(44,132,98,0.08)", border: "var(--success, #2c8462)", fg: "var(--success, #2c8462)", label: "ClinVar concordant" }
      : { bg: "var(--surface-sunken, #f4f4f4)", border: "var(--rule, #ddd)", fg: "var(--ink-soft)", label: "ClinVar uninformative" };

  const stars = concordance.review_stars ?? 0;

  if (compact) {
    return (
      <span
        className="mono"
        title={concordance.note}
        style={{
          fontSize: 10, padding: "1px 6px", borderRadius: 999,
          border: `1px solid ${tone.border}`, color: tone.fg, background: tone.bg, whiteSpace: "nowrap",
        }}
      >
        ⚠ ClinVar {concordance.clinvar_tier ?? "?"} ({stars}★)
      </span>
    );
  }

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 4,
        padding: "8px 10px", borderRadius: 8,
        border: `1px solid ${tone.border}`, background: tone.bg,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ color: tone.fg }}>{tone.label}</strong>
        {concordance.engine_tier ? (
          <span className="mono">engine {concordance.engine_tier}</span>
        ) : null}
        <span style={{ color: "var(--ink-soft)" }}>vs</span>
        <span className="mono">
          ClinVar {concordance.clinvar_significance ?? concordance.clinvar_tier ?? "—"} ({stars}★)
        </span>
      </div>
      {concordance.note ? (
        <span style={{ color: "var(--ink-soft)", lineHeight: 1.5 }}>{concordance.note}</span>
      ) : null}
    </div>
  );
}
