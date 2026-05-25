"""Inheritance model assignment (PRD §4.3).

Generalized to any pedigree shape — never trio-locked. For each joint variant,
emit the set of consistent inheritance models and a confidence flag.

Compound het requires a *gene-aware* second pass with parental phasing; that
runs in `compound_het_pass` after annotation has assigned a gene per variant.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable, Optional

from .joint import JointVariant
from .models import Affected, InheritanceModel, Pedigree, Sex


def assign_models(
    variant: JointVariant, pedigree: Pedigree
) -> tuple[list[InheritanceModel], str]:
    members = {m.id: m for m in pedigree.members}
    affected = {mid for mid, m in members.items() if m.affected == Affected.affected}
    unaffected = {mid for mid, m in members.items() if m.affected == Affected.unaffected}
    parents = _parents_of(pedigree)

    models: list[InheritanceModel] = []
    confidence = "high"

    chrom = variant.chrom.lower().lstrip("chr")
    is_x = chrom == "x"
    is_y = chrom == "y"
    is_mito = chrom in ("m", "mt")

    for proband_id in affected:
        gt = variant.genotypes.get(proband_id)
        if gt is None or gt == 0:
            continue
        fa, mo = parents.get(proband_id, (None, None))
        fa_gt = variant.genotypes.get(fa) if fa else None
        mo_gt = variant.genotypes.get(mo) if mo else None

        # De novo (PRD §4.3, §7 PS2/PM6).
        # Strict (parentage confirmed): alt in proband, ref in BOTH parents at adequate depth.
        # Assumed (parentage unconfirmed): the one parent we have is 0/0 — fires PM6 (Moderate)
        #   rather than PS2 (Strong) via the confidence='medium' downgrade in acmg/criteria.py.
        # When neither parent has a VCF, we can't infer de novo at all.
        if gt >= 1:
            parents_present = [p for p in (fa, mo) if p and p in variant.genotypes]
            if len(parents_present) == 2 and fa_gt == 0 and mo_gt == 0:
                models.append("de_novo")
                if (variant.depths.get(fa) or 0) < 10 or (variant.depths.get(mo) or 0) < 10:
                    confidence = "low"
            elif len(parents_present) == 1 and all(variant.genotypes.get(p) == 0 for p in parents_present):
                # Duo: one parent confirmed 0/0; the other unknown. PM6 territory.
                models.append("de_novo")
                confidence = "medium"

        # AR homozygous: hom-alt in affected; parents het (when present).
        if gt == 2:
            if (fa_gt in (1, None)) and (mo_gt in (1, None)):
                models.append("ar_hom")

        # AD inherited: het in affected; transmitted from an affected parent.
        if gt == 1:
            parent_affected_carriers = [
                p for p in (fa, mo)
                if p and variant.genotypes.get(p) and members[p].affected == Affected.affected
            ]
            if parent_affected_carriers:
                models.append("ad_inherited")

        if is_x:
            models.append("x_linked_recessive" if gt == 2 or members[proband_id].sex == Sex.male else "x_linked_dominant")
        if is_y:
            models.append("y_linked")
        if is_mito:
            models.append("mitochondrial")

    if not models:
        models.append("unresolved")
        confidence = "low"
    return list(dict.fromkeys(models)), confidence


def compound_het_pass(
    variants_with_gene: list[tuple[JointVariant, Optional[str]]],
    pedigree: Pedigree,
) -> dict[tuple, list[InheritanceModel]]:
    """Resolve compound-het configurations gene-by-gene using parental phasing.

    Returns map: variant.key -> additional models to attach.
    Trans configuration: in an affected proband, two hets — one inherited from
    each parent (or one inherited + one de novo).
    """
    by_gene: dict[str, list[JointVariant]] = defaultdict(list)
    for v, gene in variants_with_gene:
        if gene:
            by_gene[gene].append(v)

    parents = _parents_of(pedigree)
    affected = [m.id for m in pedigree.members if m.affected == Affected.affected]
    out: dict[tuple, list[InheritanceModel]] = defaultdict(list)

    for gene, vs in by_gene.items():
        if len(vs) < 2:
            continue
        for proband_id in affected:
            hets = [v for v in vs if variant_gt(v, proband_id) == 1]
            if len(hets) < 2:
                continue
            fa, mo = parents.get(proband_id, (None, None))
            paternal = [v for v in hets if fa and variant_gt(v, fa) in (1, 2) and variant_gt(v, mo) in (0, None)]
            maternal = [v for v in hets if mo and variant_gt(v, mo) in (1, 2) and variant_gt(v, fa) in (0, None)]
            if paternal and maternal:
                for v in paternal + maternal:
                    out[v.key].append("comp_het")
    return out


def variant_gt(v: JointVariant, mid: Optional[str]) -> Optional[int]:
    return v.genotypes.get(mid) if mid else None


def _parents_of(pedigree: Pedigree) -> dict[str, tuple[Optional[str], Optional[str]]]:
    p: dict[str, list[str]] = defaultdict(list)
    for parent_id, child_id, kind in pedigree.relations:
        if kind == "parent":
            p[child_id].append(parent_id)
    return {c: (lst[0] if len(lst) >= 1 else None, lst[1] if len(lst) >= 2 else None) for c, lst in p.items()}
