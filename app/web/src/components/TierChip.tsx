import type { Tier } from "../types";

/** Tier chip — always renders the letter token for colorblind safety (Design Spec §2, §5.3). */
export function TierChip({ tier, strength }: { tier: Tier; strength?: string }) {
  const outlined = tier === "VUS";
  return (
    <span
      className={`tier-chip tier-${tier}${outlined ? " outlined" : ""}`}
      aria-label={`ACMG tier ${tier}${strength ? ` (${strength})` : ""}`}
      title={`ACMG tier ${tier}${strength ? ` · ${strength}` : ""}`}
    >
      {tier}
      {strength ? <span style={{ marginLeft: 6, opacity: 0.85 }}>{strength}</span> : null}
    </span>
  );
}
