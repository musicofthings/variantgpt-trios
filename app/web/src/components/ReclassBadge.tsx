import type { Tier } from "../types";

/** Reclassification delta pill — sienna, mono, lists changed criteria on hover (Design Spec §5.4). */
export function ReclassBadge({
  from,
  to,
  delta,
  criteria,
}: { from: Tier; to: Tier; delta: number; criteria?: string[] }) {
  const sign = delta > 0 ? "+" : "";
  return (
    <span
      className="reclass-badge"
      title={criteria?.length ? `Changed: ${criteria.join(", ")}` : undefined}
      aria-label={`Reclassification proposal ${from} to ${to}, delta ${sign}${delta}`}
    >
      <span>{from} → {to}</span>
      <span aria-hidden>Δ {sign}{delta}</span>
    </span>
  );
}
