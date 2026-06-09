"""Structural-variant / CNV pipeline orchestrator (PRD §4.x).

Ties the SV stages together: GATK gCNV / Manta calling → AnnotSV annotation →
ClinGen CNV classification (acmg/cnv.py). Mirrors pipeline.run_case: the heavy
external tools run when present on PATH, and the in-Python stages (parse,
inheritance, classify) always run so the pipeline is exercisable from a
pre-annotated AnnotSV TSV in CI.

Inheritance for SVs reuses the trio logic in spirit: a CNV present in the
proband and absent from both (tested) parents is de novo — supporting evidence
in the ClinGen rubric (Section 5).
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .acmg import cnv
from .annotation_sources import annotsv
from .models import Affected, MemberCall, Pedigree, StructuralVariant

_CARRIER = {"het", "hom_alt"}


def _parents_of(pedigree: Pedigree) -> dict[str, tuple[Optional[str], Optional[str]]]:
    from collections import defaultdict
    p: dict[str, list[str]] = defaultdict(list)
    for parent_id, child_id, kind in pedigree.relations:
        if kind == "parent":
            p[child_id].append(parent_id)
    return {c: (lst[0] if lst else None, lst[1] if len(lst) > 1 else None) for c, lst in p.items()}


def assign_sv_inheritance(sv: StructuralVariant, pedigree: Pedigree) -> None:
    """Set de_novo + confidence on an SV from its per-member calls.

    De novo: an affected proband carries the SV and both parents are confirmed
    non-carriers (high confidence), or one parent is untested (medium). Without
    per-member SV calls (e.g. a true singleton) inheritance stays unresolved."""
    if not sv.calls:
        sv.inheritance_models = ["unresolved"]
        sv.inheritance_confidence = "low"
        return
    zyg = {c.member_id: c.zygosity for c in sv.calls}
    parents = _parents_of(pedigree)
    affected = [m.id for m in pedigree.members if m.affected == Affected.affected]

    models: list[str] = []
    confidence = "medium"
    for proband_id in affected:
        if zyg.get(proband_id) not in _CARRIER:
            continue
        fa, mo = parents.get(proband_id, (None, None))
        fa_z, mo_z = zyg.get(fa), zyg.get(mo)
        parent_states = [(p, zyg.get(p)) for p in (fa, mo) if p]
        carrier_parents = [p for p, z in parent_states if z in _CARRIER]
        noncarrier_parents = [p for p, z in parent_states if z == "hom_ref"]
        if carrier_parents:
            models.append("ad_inherited" if any(
                m.id in carrier_parents and m.affected == Affected.affected
                for m in pedigree.members
            ) else "het_inherited")
        elif len(noncarrier_parents) == 2:
            models.append("de_novo")
            confidence = "high"
        elif len(noncarrier_parents) == 1:
            models.append("de_novo")
            confidence = "medium"

    sv.inheritance_models = list(dict.fromkeys(models)) or ["unresolved"]  # type: ignore[assignment]
    sv.inheritance_confidence = confidence if models else "low"


def classify_svs(
    svs: list[StructuralVariant], pedigree: Optional[Pedigree] = None
) -> list[StructuralVariant]:
    """Assign inheritance (if a pedigree is given) and run the ClinGen classifier."""
    for sv in svs:
        if pedigree is not None:
            assign_sv_inheritance(sv, pedigree)
    return cnv.classify_all(svs)


def run_sv_from_annotsv(
    annotsv_tsv: Path,
    pedigree: Optional[Pedigree] = None,
    calls_by_sv: Optional[dict[str, list[MemberCall]]] = None,
) -> list[StructuralVariant]:
    """Entry point from a pre-annotated AnnotSV TSV (the post-calling artifact).

    `calls_by_sv` optionally supplies per-member zygosity keyed by AnnotSV_ID so
    trio inheritance (de novo) can be evaluated."""
    svs = annotsv.parse_tsv(annotsv_tsv)
    if calls_by_sv:
        for sv in svs:
            sv.calls = calls_by_sv.get(sv.id, [])
    return classify_svs(svs, pedigree)
