"""Engine-vs-ClinVar concordance flagging tests (PRD §4.5)."""
from __future__ import annotations

from variantgpt_engine.acmg.concordance import assess, assess_all, assess_svs, map_significance
from variantgpt_engine.models import ClinVarRecord, StructuralVariant, Variant


def _v(sig: str | None, stars: int | None, **kw) -> Variant:
    cv = ClinVarRecord(clinical_significance=sig, review_stars=stars) if sig else None
    return Variant(id="x", chrom="1", pos=1, ref="A", alt="T", clinvar=cv, **kw)


def test_map_significance():
    assert map_significance("Pathogenic") == "P"
    assert map_significance("Likely pathogenic") == "LP"
    assert map_significance("Benign") == "B"
    assert map_significance("Likely benign") == "LB"
    assert map_significance("Uncertain significance") == "VUS"
    assert map_significance("Conflicting interpretations of pathogenicity") is None
    assert map_significance("Pathogenic/Likely pathogenic") == "P"


def test_discordant_lp_vs_benign_2star():
    v = _v("Benign", 2)
    c = assess(v, "LP")
    assert c is not None and c.status == "discordant"
    assert c.clinvar_tier == "B" and c.engine_tier == "LP"


def test_low_star_benign_is_uninformative():
    v = _v("Benign", 1)
    c = assess(v, "LP")
    assert c is not None and c.status == "uninformative"


def test_concordant_when_directions_agree():
    v = _v("Pathogenic", 3)
    c = assess(v, "LP")
    assert c is not None and c.status == "concordant"


def test_conflicting_clinvar_is_uninformative():
    v = _v("Conflicting interpretations of pathogenicity", 1)
    c = assess(v, "LP")
    assert c is not None and c.status == "uninformative"


def test_no_clinvar_returns_none():
    v = _v(None, None)
    assert assess(v, "LP") is None


def test_assess_all_uses_reclass_tier_and_counts_discordant():
    v = _v("Likely benign", 2)
    v.baseline_tier = "LP"
    v.reclass_tier = "LP"
    n = assess_all([v])
    assert n == 1 and v.clinvar_concordance.status == "discordant"


def test_sv_clinvar_concordance():
    # Engine calls a deletion Pathogenic; ClinVar SV (2★) says Benign → discordant.
    sv = StructuralVariant(
        id="sv1", chrom="1", start=1, end=100000, sv_type="DEL", tier="P",
        clinvar=ClinVarRecord(clinical_significance="Benign", review_stars=2),
    )
    n = assess_svs([sv])
    assert n == 1
    assert sv.clinvar_concordance is not None and sv.clinvar_concordance.status == "discordant"


def test_sv_without_clinvar_has_no_concordance():
    sv = StructuralVariant(id="sv1", chrom="1", start=1, end=100, sv_type="DEL", tier="P")
    assert assess_svs([sv]) == 0
    assert sv.clinvar_concordance is None
