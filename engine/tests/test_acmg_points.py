"""Boundary tests for the ACMG point engine (PRD §8)."""
from __future__ import annotations

from variantgpt_engine.acmg.engine import tier_for, DEFAULT_THRESHOLDS


def test_tier_boundaries():
    assert tier_for(10) == "P"
    assert tier_for(9) == "LP"
    assert tier_for(6) == "LP"
    assert tier_for(5) == "VUS"
    assert tier_for(0) == "VUS"
    assert tier_for(-1) == "LB"
    assert tier_for(-6) == "LB"
    assert tier_for(-7) == "B"


def test_ba1_hard_override():
    assert tier_for(15, ba1=True) == "B"
    assert tier_for(-2, ba1=True) == "B"
