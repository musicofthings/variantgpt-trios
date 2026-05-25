"""HPO-driven prioritization (PRD §4.7).

Score = w1 * inheritance_consistency + w2 * gene_disease_validity
       + w3 * deleteriousness + w4 * clinvar_evidence
       + w5 * hpo_semantic_similarity

HPO semantic similarity uses Resnik/Phrank/Lin against gene→HPO associations.
This module currently exposes the integration shape; per-component scorers
land alongside the annotation adapters.
"""
from __future__ import annotations

from .models import Variant

WEIGHTS = {
    "inheritance": 0.20,
    "gene_validity": 0.15,
    "deleteriousness": 0.25,
    "clinvar": 0.15,
    "hpo": 0.25,
}


def priority(variant: Variant, hpo_terms: list[str]) -> float:
    s = 0.0
    if "de_novo" in variant.inheritance_models or "comp_het" in variant.inheritance_models:
        s += WEIGHTS["inheritance"]
    # Deleteriousness shortcut from PP3 having fired.
    if any(e.criterion == "PP3" and e.fired for e in variant.evidence):
        s += WEIGHTS["deleteriousness"]
    if variant.baseline_tier in ("P", "LP"):
        s += WEIGHTS["clinvar"]
    # gene_validity + hpo wired in once adapters exist.
    variant.priority_score = s
    return s
