"""ClinGen/ACMG 2019 copy-number variant classifier (Riggs et al. 2020).

This is a SEPARATE rubric from the SNV Tavtigian point engine — it scores a CNV
by *dosage sensitivity*, not by ACMG/AMP sequence-variant criteria, which is how
Franklin and ClinGen classify large deletions/duplications.

Two scoring tables, selected by dosage direction:
  - copy-number LOSS  (deletions)      → haploinsufficiency (HI) evidence
  - copy-number GAIN  (duplications)   → triplosensitivity (TS) evidence

Each contributes a signed fractional score across five sections:
  1  Initial genomic content (does it contain protein-coding/functional elements)
  2  Overlap with established dosage-sensitive genes/regions OR benign regions
  3  Number of protein-coding genes involved
  4  Case/segregation literature evidence  (curator-supplied — not auto-scored)
  5  Inheritance for the patient being studied (de novo etc.)

Final score → five-tier classification (ClinGen 2019 cutoffs):
    >=  0.99            Pathogenic
     0.90 .. 0.98       Likely pathogenic
    -0.89 .. 0.89       VUS
    -0.98 .. -0.90      Likely benign
    <= -0.99            Benign

Honesty notes (mirrors the SNV engine's stubbed PS3/PS4):
  - Section 4 (published case/segregation evidence) needs a curated case
    database we don't host; it is exposed as a curator-suppliable hook and
    defaults to 0, never fabricated.
  - The fine 2C–2E partial-overlap sub-branches are collapsed to a single
    conservative "partial overlap of an established gene" value; a curator can
    refine. Section/score values follow the published anchors.
"""
from __future__ import annotations

from ..models import CNVEvidenceItem, DosageRegion, StructuralVariant, Tier
from . import cnv_dosage

# ── Tier cutoffs ──────────────────────────────────────────────────────────
P_MIN = 0.99
LP_MIN = 0.90
LB_MAX = -0.90
B_MAX = -0.99


def tier_for(score: float) -> Tier:
    if score >= P_MIN:
        return "P"
    if score >= LP_MIN:
        return "LP"
    if score <= B_MAX:
        return "B"
    if score <= LB_MAX:
        return "LB"
    return "VUS"


# Gene-count section thresholds differ for loss vs gain (Riggs 2020 §3).
_LOSS_GENE_TIERS = ((35, 0.90), (25, 0.45))   # (min_genes, score)
_GAIN_GENE_TIERS = ((50, 0.90), (35, 0.45))


def _direction(sv: StructuralVariant) -> str:
    if sv.dosage_direction:
        return sv.dosage_direction
    if sv.sv_type == "DEL":
        return "loss"
    if sv.sv_type == "DUP":
        return "gain"
    if sv.sv_type == "CNV" and sv.copy_number is not None:
        return "loss" if sv.copy_number < 2 else "gain"
    return "loss"  # conservative default


def _dosage(region: DosageRegion, direction: str) -> int | None:
    """The relevant ClinGen score for this region given direction; falls back to
    the in-engine seed map when AnnotSV didn't supply one."""
    score = region.hi_score if direction == "loss" else region.ts_score
    if score is None:
        ds = cnv_dosage.dosage_for(region.name)
        score = ds.hi if direction == "loss" else ds.ts
    return score


def _section1(sv: StructuralVariant) -> CNVEvidenceItem:
    """Initial assessment: does the CNV contain protein-coding / known functional
    elements? No coding content → -0.60 (benign-leaning, effectively terminal)."""
    if sv.genes or sv.dosage_overlaps:
        return CNVEvidenceItem(section="1A", score=0.0, source="annotsv",
                               detail="contains protein-coding / functional elements")
    return CNVEvidenceItem(section="1B", score=-0.60, source="annotsv",
                           detail="no protein-coding or known functional elements")


def _section2(sv: StructuralVariant, direction: str) -> list[CNVEvidenceItem]:
    """Overlap with established dosage-sensitive genes/regions, predicted HI, or
    established benign regions.

    ClinGen scores the single strongest applicable Section-2 item, not the sum
    across every overlapped gene — so a deletion spanning three HI genes is
    still +1.00, not +3.00. We pick the strongest established (or benign) hit
    and surface predicted-HI only when no established gene already drove it."""
    label = "HI" if direction == "loss" else "TS"
    best: CNVEvidenceItem | None = None
    benign: CNVEvidenceItem | None = None
    predicted_hit = False

    for r in sv.dosage_overlaps:
        score = _dosage(r, direction)
        if score == 3:  # established dosage-sensitive
            if r.overlap == "full":
                cand = CNVEvidenceItem(
                    section="2A", score=1.00, source="clingen_dosage",
                    detail=f"complete overlap of established {label} {r.kind} {r.name} ({label}=3)")
            else:
                # Collapsed 2C–2E: partial overlap of an established gene is
                # likely disruptive but not definitive on its own.
                cand = CNVEvidenceItem(
                    section="2C-E", score=0.90, source="clingen_dosage",
                    detail=f"partial overlap of established {label} {r.kind} {r.name} ({label}=3)")
            if best is None or cand.score > best.score:
                best = cand
        elif score == 40 and benign is None:  # dosage sensitivity unlikely
            benign = CNVEvidenceItem(
                section="2F", score=-1.00, source="clingen_dosage",
                detail=f"{r.name}: dosage sensitivity unlikely ({label}=40)")
        elif r.pli is not None and r.pli >= 0.9 and direction == "loss":
            predicted_hit = True

    if best is not None:
        return [best]
    if benign is not None:
        return [benign]
    if direction == "loss" and predicted_hit:
        return [CNVEvidenceItem(
            section="2H", score=0.15, source="gnomad_pli",
            detail="predicted haploinsufficient gene (pLI ≥ 0.9)")]
    return [CNVEvidenceItem(
        section="2", score=0.0, applied=False, source="clingen_dosage",
        detail="no overlap with established dosage-sensitive or benign region")]


def _section3(sv: StructuralVariant, direction: str) -> CNVEvidenceItem:
    """Number of protein-coding genes wholly or partially involved."""
    n = len(sv.genes)
    tiers = _LOSS_GENE_TIERS if direction == "loss" else _GAIN_GENE_TIERS
    for min_genes, score in tiers:
        if n >= min_genes:
            return CNVEvidenceItem(section="3", score=score, source="annotsv",
                                   detail=f"{n} protein-coding genes involved")
    return CNVEvidenceItem(section="3", score=0.0, applied=False, source="annotsv",
                           detail=f"{n} protein-coding genes involved (below scoring threshold)")


def _section5(sv: StructuralVariant) -> CNVEvidenceItem:
    """Inheritance for the patient being studied. De novo (confirmed) is
    supporting evidence toward pathogenicity (Riggs 2020 §5)."""
    if "de_novo" in sv.inheritance_models:
        if sv.inheritance_confidence == "high":
            return CNVEvidenceItem(section="5A", score=0.45, source="trio_phasing",
                                   detail="confirmed de novo (both parents tested)")
        return CNVEvidenceItem(section="5A", score=0.30, source="trio_phasing",
                               detail="assumed de novo (parentage unconfirmed)")
    return CNVEvidenceItem(section="5", score=0.0, applied=False, source="trio_phasing",
                           detail="inheritance not informative")


def classify(sv: StructuralVariant, case_evidence_score: float = 0.0) -> StructuralVariant:
    """Score and classify a structural variant in place. `case_evidence_score`
    is the Section-4 curator-supplied literature/case contribution (default 0)."""
    direction = _direction(sv)
    sv.dosage_direction = direction  # type: ignore[assignment]

    ledger: list[CNVEvidenceItem] = []
    s1 = _section1(sv)
    ledger.append(s1)

    # 1B (no functional content) is effectively terminal — benign-leaning.
    if s1.section == "1B":
        sv.evidence = ledger
        sv.score = round(s1.score, 4)
        sv.tier = tier_for(sv.score)
        return sv

    ledger.extend(_section2(sv, direction))
    ledger.append(_section3(sv, direction))
    if case_evidence_score:
        ledger.append(CNVEvidenceItem(section="4", score=case_evidence_score,
                                      source="curator", detail="curator-supplied case/literature evidence"))
    ledger.append(_section5(sv))

    total = sum(i.score for i in ledger if i.applied)
    sv.evidence = ledger
    sv.score = round(total, 4)
    sv.tier = tier_for(sv.score)
    return sv


def classify_all(svs: list[StructuralVariant]) -> list[StructuralVariant]:
    return [classify(sv) for sv in svs]
