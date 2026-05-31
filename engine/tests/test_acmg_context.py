"""Context-aware ACMG criteria tests (PP4 / PM3 / PP1) + baseline re-tally."""
from __future__ import annotations

from variantgpt_engine.acmg.context import (
    augment_context_evidence, evaluate_pm3, evaluate_pp1, evaluate_pp4, retally,
)
from variantgpt_engine.models import (
    Affected, ClinVarRecord, EvidenceItem, Member, MemberCall, Pedigree,
    PhenotypeRelevance, PhenotypeScore, PhenotypeTermContribution, Role, Sex, Variant,
)


def _rel(phrank: float, coverage: float = 0.0) -> PhenotypeRelevance:
    return PhenotypeRelevance(
        coverage=PhenotypeScore(percent=coverage),
        resnik=PhenotypeScore(percent=phrank),
        phrank=PhenotypeScore(
            percent=phrank,
            matched_terms=[PhenotypeTermContribution(hpo_id="HP:0001903", contribution=0.4)],
        ),
    )


def _trio() -> Pedigree:
    return Pedigree(
        members=[
            Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected),
            Member(id="f", role=Role.father, sex=Sex.male, affected=Affected.unaffected),
            Member(id="m", role=Role.mother, sex=Sex.female, affected=Affected.unaffected),
        ],
        relations=[("f", "p", "parent"), ("m", "p", "parent")],
    )


# ───────────────────────── PP4 ─────────────────────────

def test_pp4_fires_on_high_relevance():
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="HBB",
                phenotype_relevance=_rel(73.0))
    item = evaluate_pp4(v)
    assert item.fired and item.strength == "P" and item.points == 1


def test_pp4_not_fired_on_low_relevance():
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="GJB2",
                phenotype_relevance=_rel(5.0))
    assert not evaluate_pp4(v).fired


def test_pp4_fires_on_full_coverage_even_if_graded_lower():
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="X",
                phenotype_relevance=_rel(40.0, coverage=100.0))
    assert evaluate_pp4(v).fired


def test_pp4_absent_when_no_phenotype():
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="X")
    assert not evaluate_pp4(v).fired


# ───────────────────────── PM3 ─────────────────────────

def _comp_het(vid: str, *, pathogenic: bool, hgvs: str) -> Variant:
    cv = ClinVarRecord(clinical_significance="Pathogenic", review_stars=2) if pathogenic else None
    return Variant(
        id=vid, chrom="7", pos=int(vid[-1]) * 10, ref="A", alt="T", gene="CFTR",
        hgvs_c=hgvs, inheritance_models=["comp_het"], clinvar=cv,
    )


def test_pm3_fires_with_pathogenic_trans_partner():
    novel = _comp_het("v1", pathogenic=False, hgvs="c.100A>T")
    known = _comp_het("v2", pathogenic=True, hgvs="c.1521_1523delCTT")
    out = evaluate_pm3([novel, known])
    assert out["v1"].fired and out["v1"].strength == "M"
    # The known-pathogenic allele has no *other* pathogenic partner here.
    assert not out["v2"].fired


def test_pm3_not_fired_without_pathogenic_partner():
    a = _comp_het("v1", pathogenic=False, hgvs="c.100A>T")
    b = _comp_het("v2", pathogenic=False, hgvs="c.200A>T")
    out = evaluate_pm3([a, b])
    assert not out["v1"].fired and not out["v2"].fired


def test_pm3_ignores_low_star_or_benign_partner():
    novel = _comp_het("v1", pathogenic=False, hgvs="c.100A>T")
    weak = _comp_het("v2", pathogenic=True, hgvs="c.200A>T")
    weak.clinvar = ClinVarRecord(clinical_significance="Pathogenic", review_stars=0)  # 0 stars
    out = evaluate_pm3([novel, weak])
    assert not out["v1"].fired


# ───────────────────────── PP1 ─────────────────────────

def test_pp1_not_fired_for_single_affected_trio():
    """A standard trio has one affected member — no segregation power."""
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="X",
                calls=[MemberCall(member_id="p", role="proband", zygosity="het")])
    assert not evaluate_pp1(v, _trio()).fired


def test_pp1_fires_on_clean_cosegregation():
    ped = Pedigree(members=[
        Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected),
        Member(id="s", role=Role.sibling, sex=Sex.female, affected=Affected.affected),
        Member(id="f", role=Role.father, sex=Sex.male, affected=Affected.unaffected),
    ])
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="X", calls=[
        MemberCall(member_id="p", role="proband", zygosity="het"),
        MemberCall(member_id="s", role="sibling", zygosity="het"),
        MemberCall(member_id="f", role="father", zygosity="hom_ref"),
    ])
    item = evaluate_pp1(v, ped)
    assert item.fired and item.strength == "P"


def test_pp1_vetoed_by_affected_noncarrier():
    ped = Pedigree(members=[
        Member(id="p", role=Role.proband, sex=Sex.male, affected=Affected.affected),
        Member(id="s", role=Role.sibling, sex=Sex.female, affected=Affected.affected),
        Member(id="f", role=Role.father, sex=Sex.male, affected=Affected.unaffected),
    ])
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", gene="X", calls=[
        MemberCall(member_id="p", role="proband", zygosity="het"),
        MemberCall(member_id="s", role="sibling", zygosity="hom_ref"),  # affected non-carrier
        MemberCall(member_id="f", role="father", zygosity="hom_ref"),
    ])
    assert not evaluate_pp1(v, ped).fired


# ───────────────────────── driver + re-tally ─────────────────────────

def test_augment_retallies_baseline_tier_and_points():
    v = Variant(
        id="x", chrom="1", pos=1, ref="A", alt="T", gene="HBB",
        phenotype_relevance=_rel(80.0),
        baseline_points=5, baseline_tier="VUS",
        evidence=[
            EvidenceItem(criterion="PM2", fired=True, strength="P", points=1),
            EvidenceItem(criterion="PM1", fired=True, strength="M", points=2),
            EvidenceItem(criterion="PP3", fired=True, strength="P", points=1),
            EvidenceItem(criterion="PVS1", fired=False),
            EvidenceItem(criterion="PP4", fired=False),
            EvidenceItem(criterion="PM3", fired=False),
            EvidenceItem(criterion="PP1", fired=False),
        ],
    )
    fired = augment_context_evidence([v], _trio())
    assert fired["PP4"] == 1
    # 1 (PM2) + 2 (PM1) + 1 (PP3) + 1 (PP4) = 5 points → still VUS, but PP4 now in ledger.
    assert v.baseline_points == 5
    pp4 = next(e for e in v.evidence if e.criterion == "PP4")
    assert pp4.fired


def test_retally_handles_ba1_override():
    v = Variant(id="x", chrom="1", pos=1, ref="A", alt="T", evidence=[
        EvidenceItem(criterion="BA1", fired=True, strength="BA", points=0),
        EvidenceItem(criterion="PM2", fired=True, strength="P", points=1),
    ])
    retally(v)
    assert v.baseline_tier == "B"
