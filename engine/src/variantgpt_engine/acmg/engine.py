"""ClinGen SVI Bayesian point-based ACMG classifier (PRD §4.5).

Tavtigian transform — each criterion contributes signed points by strength:
    Pathogenic:   Supporting +1, Moderate +2, Strong +4, VeryStrong +8
    Benign:       Supporting -1, Strong -4
    Stand-alone benign (BA1) handled as a hard override.

Tier mapping (config-driven; see DEFAULT_THRESHOLDS):
    >= +10  P
    +6..+9  LP
    0..+5   VUS  (no benign dominance)
    -1..-6  LB
    <= -7   B
"""
from __future__ import annotations

from dataclasses import dataclass

from ..models import EvidenceItem, Tier, Variant
from .points import STRENGTH_POINTS, points_for
from .criteria import CRITERION_REGISTRY


@dataclass(frozen=True)
class Thresholds:
    p_min: int = 10
    lp_min: int = 6
    lb_max: int = -1
    b_max: int = -7


DEFAULT_THRESHOLDS = Thresholds()


__all__ = [
    "Thresholds", "DEFAULT_THRESHOLDS", "STRENGTH_POINTS", "points_for",
    "tier_for", "classify",
]


def tier_for(points: int, t: Thresholds = DEFAULT_THRESHOLDS, ba1: bool = False) -> Tier:
    if ba1:
        return "B"
    if points >= t.p_min:
        return "P"
    if points >= t.lp_min:
        return "LP"
    if points <= t.b_max:
        return "B"
    if points <= t.lb_max:
        return "LB"
    return "VUS"


def _reconcile_insilico(ledger: list[EvidenceItem]) -> None:
    """Prevent in-silico double-counting (Pejaver et al. / ClinGen SVI).

    PP3 already captures the strong predictor signal; PM1's predictor-concordance
    proxy fires on the same scores. When PP3 has escalated to Strong from
    predictors, suppress PM1 so a single in-silico signal can't contribute both
    +4 and +2 (which alone would reach the LP band). PM1 still stands on its own
    when PP3 only fired at Supporting (or not at all)."""
    by = {e.criterion: e for e in ledger}
    pp3 = by.get("PP3")
    pm1 = by.get("PM1")
    if (pp3 and pp3.fired and pp3.strength == "S"
            and pm1 and pm1.fired and pm1.source == "predictors_strong_concordance"):
        idx = ledger.index(pm1)
        ledger[idx] = EvidenceItem(
            criterion="PM1", fired=False, source="suppressed",
            detail="suppressed: predictor signal already counted by PP3 (Strong) — no in-silico double-count",
        )


def classify(variant: Variant, t: Thresholds = DEFAULT_THRESHOLDS) -> tuple[Tier, int, list[EvidenceItem]]:
    """Run every registered criterion against the variant, return (tier, points, ledger).

    The ledger contains BOTH fired and not-fired criteria — the UI evidence
    panel needs the full set to render "considered but not fired" rows.
    """
    ledger: list[EvidenceItem] = []
    for name, fn in CRITERION_REGISTRY.items():
        item = fn(variant)
        ledger.append(item if item is not None else EvidenceItem(criterion=name, fired=False))

    _reconcile_insilico(ledger)

    total = 0
    ba1 = False
    for item in ledger:
        if item.fired:
            total += item.points
            if item.criterion == "BA1":
                ba1 = True
    return tier_for(total, t, ba1=ba1), total, ledger
