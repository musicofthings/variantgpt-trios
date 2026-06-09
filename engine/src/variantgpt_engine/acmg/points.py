"""Shared strength → signed points table (Tavtigian transform).

Lives in its own module so the criterion evaluators and the tier classifier can
both depend on it without a circular import.
"""
from __future__ import annotations

STRENGTH_POINTS: dict[str, int] = {
    "VS": 8, "S": 4, "M": 2, "P": 1,
    "BS": -4, "BP": -1,
    "BA": -1000,  # stand-alone benign → hard Benign override (sentinel)
}


def points_for(strength: str | None) -> int:
    return STRENGTH_POINTS.get(strength or "", 0)


# Pathogenic-strength ordering, strongest → weakest. Used by the PVS1 decision
# tree to *downgrade* strength (e.g. NMD-escape: VS → S → M) without juggling
# raw point values.
_PATHO_RANK: dict[str, int] = {"VS": 4, "S": 3, "M": 2, "P": 1}


def weaker_strength(a: str, b: str) -> str:
    """Return the weaker of two pathogenic strengths (e.g. weaker_strength("VS","M") == "M")."""
    return a if _PATHO_RANK.get(a, 0) <= _PATHO_RANK.get(b, 0) else b


def downgrade(strength: str, steps: int = 1) -> str | None:
    """Step a pathogenic strength down the VS→S→M→P ladder. Returns None if it
    falls below Supporting (i.e. the criterion should not fire)."""
    rank = _PATHO_RANK.get(strength, 0) - steps
    if rank <= 0:
        return None
    for s, r in _PATHO_RANK.items():
        if r == rank:
            return s
    return None
