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
