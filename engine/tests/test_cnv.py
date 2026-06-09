"""ClinGen/ACMG 2019 (Riggs 2020) CNV classifier tests."""
from __future__ import annotations

from variantgpt_engine.acmg import cnv
from variantgpt_engine.models import DosageRegion, MemberCall, StructuralVariant


def _sv(**kw) -> StructuralVariant:
    base = dict(id="sv1", chrom="1", start=1000, end=200000, sv_type="DEL")
    base.update(kw)
    return StructuralVariant(**base)


# ───────────────────────── tier cutoffs ─────────────────────────

def test_tier_for_cutoffs():
    assert cnv.tier_for(1.00) == "P"
    assert cnv.tier_for(0.99) == "P"
    assert cnv.tier_for(0.90) == "LP"
    assert cnv.tier_for(0.50) == "VUS"
    assert cnv.tier_for(-0.50) == "VUS"
    assert cnv.tier_for(-0.90) == "LB"
    assert cnv.tier_for(-0.99) == "B"


# ───────────────────────── loss scoring ─────────────────────────

def test_loss_over_established_hi_gene_is_pathogenic():
    sv = _sv(sv_type="DEL", genes=["NF1"],
             dosage_overlaps=[DosageRegion(name="NF1", hi_score=3, overlap="full")])
    cnv.classify(sv)
    # 2A complete overlap of established HI gene = +1.00 → Pathogenic.
    assert sv.score >= 0.99 and sv.tier == "P"


def test_loss_partial_overlap_established_hi_is_likely_pathogenic():
    sv = _sv(sv_type="DEL", genes=["NF1"],
             dosage_overlaps=[DosageRegion(name="NF1", hi_score=3, overlap="partial")])
    cnv.classify(sv)
    assert sv.tier == "LP"  # +0.90


def test_no_coding_content_is_benign_leaning():
    sv = _sv(sv_type="DEL", genes=[], dosage_overlaps=[])
    cnv.classify(sv)
    assert sv.score == -0.60 and sv.tier == "VUS"
    # 1B is terminal — only the section-1 row is present.
    assert [e.section for e in sv.evidence] == ["1B"]


def test_loss_gene_count_section3():
    genes = [f"G{i}" for i in range(40)]
    sv = _sv(sv_type="DEL", genes=genes)
    cnv.classify(sv)
    s3 = next(e for e in sv.evidence if e.section == "3")
    assert s3.score == 0.90  # ≥35 genes (loss)


def test_de_novo_adds_section5():
    sv = _sv(sv_type="DEL", genes=["NF1"],
             dosage_overlaps=[DosageRegion(name="NF1", hi_score=3, overlap="full")],
             inheritance_models=["de_novo"], inheritance_confidence="high")
    cnv.classify(sv)
    s5 = next(e for e in sv.evidence if e.section.startswith("5"))
    assert s5.applied and s5.score == 0.45


def test_dosage_falls_back_to_seed_map():
    # No hi_score supplied on the region — classifier should look up cnv_dosage.
    sv = _sv(sv_type="DEL", genes=["TP53"], dosage_overlaps=[DosageRegion(name="TP53")])
    cnv.classify(sv)
    assert sv.tier == "P"


# ───────────────────────── gain scoring ─────────────────────────

def test_gain_over_established_ts_gene_is_pathogenic():
    sv = _sv(sv_type="DUP", genes=["PMP22"],
             dosage_overlaps=[DosageRegion(name="PMP22", ts_score=3, overlap="full")])
    cnv.classify(sv)
    assert sv.dosage_direction == "gain" and sv.tier == "P"


def test_gain_gene_count_threshold_higher_than_loss():
    genes = [f"G{i}" for i in range(40)]  # ≥35 but <50
    sv = _sv(sv_type="DUP", genes=genes)
    cnv.classify(sv)
    s3 = next(e for e in sv.evidence if e.section == "3")
    assert s3.score == 0.45  # gain: 35–49 → 0.45 (loss would be 0.90)


def test_cnv_copy_number_infers_direction():
    sv = _sv(sv_type="CNV", copy_number=1, genes=["NF1"],
             dosage_overlaps=[DosageRegion(name="NF1", hi_score=3, overlap="full")])
    cnv.classify(sv)
    assert sv.dosage_direction == "loss"
