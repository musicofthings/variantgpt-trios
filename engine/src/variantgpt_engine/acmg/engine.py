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
from typing import Iterable

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


def classify(variant: Variant, t: Thresholds = DEFAULT_THRESHOLDS) -> tuple[Tier, int, list[EvidenceItem]]:
    """Run every registered criterion against the variant, return (tier, points, ledger).

    The ledger contains BOTH fired and not-fired criteria — the UI evidence
    panel needs the full set to render "considered but not fired" rows.
    """
    ledger: list[EvidenceItem] = []
    total = 0
    ba1 = False
    for name, fn in CRITERION_REGISTRY.items():
        item = fn(variant)
        if item is None:
            ledger.append(EvidenceItem(criterion=name, fired=False))
            continue
        ledger.append(item)
        if item.fired:
            total += item.points
            if name == "BA1":
                ba1 = True
    return tier_for(total, t, ba1=ba1), total, ledger
