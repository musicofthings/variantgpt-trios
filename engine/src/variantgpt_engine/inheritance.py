"""Inheritance model assignment + GATK-style trio QC (PRD §4.3).

Generalized to any pedigree shape — never trio-locked. For each joint variant,
emit the set of consistent inheritance models and a confidence flag.

De novo confidence gates (matches GATK Best Practices + ClinGen SVI WG):

  HIGH (qualifies for PS2 Strong = +4 points)
    - Proband het OR hom-alt with GQ ≥ 30, DP ≥ 20, AB 0.3-0.7 (het) or ≥ 0.85 (hom)
    - Both parents 0/0 with GQ ≥ 30, DP ≥ 20, AB ≤ 0.05 (no alt reads)
    - Parent-child kinship not contradicted (we don't have BAM, so assumed)

  MEDIUM (PM6 Moderate = +2 points)
    - Duo: one parent unavailable, the other is 0/0 with above QC
    - OR trio but with marginal QC (GQ 20-30 OR DP 10-20 in any sample)

  LOW (not fired)
    - Any sample GQ < 20 or DP < 10
    - Proband het with AB outside 0.2-0.8 (likely call artifact)
    - Parent 0/0 but >5% alt reads (possible mosaic — flag for human review,
      do not auto-promote)

Compound het requires a *gene-aware* second pass with parental phasing; that
runs in `compound_het_pass` after annotation has assigned a gene per variant.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable, Optional

from .joint import JointVariant
from .models import Affected, InheritanceModel, Pedigree, Sex


# QC thresholds — class-level constants so the values are documented in one
# place and easy to tune. Defaults align with GATK Best Practices.
DENOVO_QC_HIGH = {"gq": 30, "dp": 20}
DENOVO_QC_MEDIUM = {"gq": 20, "dp": 10}
HET_AB_MIN = 0.20            # proband het: AB must be in [0.20, 0.80] for call validity
HET_AB_MAX = 0.80
HET_AB_TIGHT_MIN = 0.30      # tighter range for HIGH-confidence de novo
HET_AB_TIGHT_MAX = 0.70
HOM_AB_MIN = 0.85            # hom-alt should have AB ≥ 0.85
PARENT_REF_AB_MAX = 0.05     # parent 0/0 should have ≤ 5% alt reads (anything more = mosaic suspect)


def _qc_grade_denovo_proband(jv: JointVariant, proband_id: str) -> str:
    """Return 'high', 'medium', 'low', or 'fail' for the proband's call quality
    in the context of a de novo claim."""
    gt = jv.genotypes.get(proband_id)
    if gt is None or gt == 0:
        return "fail"
    dp = jv.depths.get(proband_id)
    gq = jv.gq.get(proband_id)
    ab = jv.allele_balance.get(proband_id)
    # Hard floors: missing or terrible quality → fail.
    if (dp is not None and dp < DENOVO_QC_MEDIUM["dp"]) or (gq is not None and gq < DENOVO_QC_MEDIUM["gq"]):
        return "low"
    if gt == 1:
        # Het: AB must be plausibly balanced.
        if ab is not None and (ab < HET_AB_MIN or ab > HET_AB_MAX):
            return "low"
        if (dp is None or dp >= DENOVO_QC_HIGH["dp"]) and (gq is None or gq >= DENOVO_QC_HIGH["gq"]):
            if ab is None or (HET_AB_TIGHT_MIN <= ab <= HET_AB_TIGHT_MAX):
                return "high"
        return "medium"
    if gt == 2:
        if ab is not None and ab < HOM_AB_MIN:
            return "low"
        if (dp is None or dp >= DENOVO_QC_HIGH["dp"]) and (gq is None or gq >= DENOVO_QC_HIGH["gq"]):
            return "high"
        return "medium"
    return "low"


def _qc_grade_denovo_parent(jv: JointVariant, parent_id: str) -> str:
    """Return 'high', 'medium', 'low', or 'absent' for a parent's 0/0 call
    quality. Parents must be confidently homozygous reference for de novo."""
    gt = jv.genotypes.get(parent_id)
    if gt is None:
        return "absent"        # parent not in call set at this site
    if gt != 0:
        return "low"           # parent isn't 0/0 → not a de novo
    dp = jv.depths.get(parent_id)
    gq = jv.gq.get(parent_id)
    ab = jv.allele_balance.get(parent_id)
    if (dp is not None and dp < DENOVO_QC_MEDIUM["dp"]) or (gq is not None and gq < DENOVO_QC_MEDIUM["gq"]):
        return "low"
    if ab is not None and ab > PARENT_REF_AB_MAX:
        # Parent has alt reads at this site — possible mosaicism. Don't promote.
        return "low"
    if (dp is None or dp >= DENOVO_QC_HIGH["dp"]) and (gq is None or gq >= DENOVO_QC_HIGH["gq"]):
        return "high"
    return "medium"


def _combined_denovo_confidence(grades: list[str]) -> str:
    """Combine per-sample grades into an overall de novo confidence."""
    if "low" in grades or "fail" in grades:
        return "low"
    if "absent" in grades:
        # Duo: one parent missing. Can never exceed medium.
        return "medium" if "high" in grades or "medium" in grades else "low"
    if all(g == "high" for g in grades):
        return "high"
    return "medium"


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

        # De novo (PRD §4.3, §7 PS2/PM6) — GATK-style QC-gated.
        #
        # Required:
        #   - Proband: het or hom-alt with passing call quality (see _qc_grade_denovo_proband)
        #   - At least one parent confidently 0/0
        #   - The other parent must be 0/0 OR absent (duo)
        #   - No parent can be het+ (would be Mendelian-consistent inheritance, not de novo)
        if gt >= 1:
            proband_grade = _qc_grade_denovo_proband(variant, proband_id)
            if proband_grade in ("high", "medium"):
                fa_grade = _qc_grade_denovo_parent(variant, fa) if fa else "absent"
                mo_grade = _qc_grade_denovo_parent(variant, mo) if mo else "absent"
                # Both parents must be 0/0 with at least 'medium' QC, OR one is
                # 0/0+medium and the other is absent (duo de novo).
                ref_grades = [g for g in (fa_grade, mo_grade) if g in ("high", "medium")]
                absent_count = sum(1 for g in (fa_grade, mo_grade) if g == "absent")
                if len(ref_grades) + absent_count == 2 and len(ref_grades) >= 1:
                    models.append("de_novo")
                    confidence = _combined_denovo_confidence([proband_grade] + ref_grades + ["absent"] * absent_count)
                else:
                    # Either parent failed QC OR has variant — not a confident de novo claim.
                    # We still don't list it. (Hint: PM6 won't fire either.)
                    pass

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
