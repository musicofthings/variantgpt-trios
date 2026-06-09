"""Tests for the corrected PVS1 decision tree, PM2 missing-data guard, and the
in-silico double-count cap (LP-vs-ClinVar-benign discrepancy fixes)."""
from __future__ import annotations

from variantgpt_engine.acmg.criteria import pm2, pvs1
from variantgpt_engine.acmg.engine import classify
from variantgpt_engine.models import PopulationAF, PredictorScores, Variant


def _v(**kw) -> Variant:
    base = dict(id="x", chrom="1", pos=1, ref="A", alt="T")
    base.update(kw)
    return Variant(**base)


# ───────────────────────── PVS1 decision tree ─────────────────────────

def test_pvs1_full_strength_for_established_lof_gene_nmd_competent():
    v = _v(gene="BRCA1", consequence="stop_gained", exon="10/23")
    item = pvs1(v)
    assert item.fired and item.strength == "VS" and item.points == 8


def test_pvs1_downgraded_in_last_exon_nmd_escape():
    v = _v(gene="BRCA1", consequence="stop_gained", exon="23/23")
    item = pvs1(v)
    assert item.fired and item.strength == "S" and item.points == 4
    assert "NMD-escaping" in item.detail


def test_pvs1_does_not_fire_when_lof_not_the_mechanism():
    # MYH7 HCM is dominant-negative missense; a truncating allele must not fire PVS1.
    v = _v(gene="MYH7", consequence="frameshift_variant", exon="5/40")
    item = pvs1(v)
    assert not item.fired and "not the disease mechanism" in item.detail


def test_pvs1_capped_moderate_for_uncurated_gene():
    v = _v(gene="ZZZ9", consequence="splice_donor_variant", exon="3/12")
    item = pvs1(v)
    assert item.fired and item.strength == "M" and item.points == 2


def test_pvs1_start_lost_capped_moderate():
    v = _v(gene="BRCA1", consequence="start_lost", exon="1/23")
    item = pvs1(v)
    assert item.fired and item.strength == "M"


def test_pvs1_parses_compound_consequence():
    v = _v(gene="BRCA1", consequence="splice_donor_variant&intron_variant", exon="4/23")
    item = pvs1(v)
    assert item.fired and item.strength == "VS"


def test_pvs1_not_fired_for_missense():
    v = _v(gene="BRCA1", consequence="missense_variant")
    assert not pvs1(v).fired


def test_pvs1_alone_no_longer_forces_lp_for_uncurated_gene():
    # Old engine: any truncating variant → PVS1 VS (+8) → LP. Now an uncurated
    # gene caps at Moderate (+2), so PVS1 alone lands in VUS.
    v = _v(gene="ZZZ9", consequence="stop_gained", exon="3/12",
           populations=[PopulationAF(source="gnomad_v4_global", af=0.0)])
    tier, points, _ = classify(v)
    assert tier == "VUS"


# ───────────────────────── PM2 missing-data guard ─────────────────────────

def test_pm2_not_applied_without_gnomad_row():
    v = _v(gene="BRCA1")  # no populations at all → gnomAD never consulted
    item = pm2(v)
    assert not item.fired and "no gnomAD frequency" in item.detail


def test_pm2_fires_on_explicit_absent_row():
    v = _v(gene="BRCA1", populations=[PopulationAF(source="gnomad_v4_global", ac=0, an=None, af=0.0)])
    item = pm2(v)
    assert item.fired and item.points == 1


def test_pm2_not_fired_when_above_cutoff():
    v = _v(gene="BRCA1", populations=[PopulationAF(source="gnomad_v4_global", af=0.01)])
    assert not pm2(v).fired


# ───────────────────────── in-silico double-count cap ─────────────────────────

def test_pm1_suppressed_when_pp3_strong():
    # AlphaMissense ≥0.972 → PP3 Strong AND PM1 concordance both want to fire;
    # PM1 must be suppressed so the in-silico signal counts once (+4, not +6).
    v = _v(gene="BRCA1", consequence="missense_variant",
           predictors=PredictorScores(alphamissense=0.98, revel=0.95, cadd=31),
           populations=[PopulationAF(source="gnomad_v4_global", af=0.0)])
    tier, points, ledger = classify(v)
    pm1 = next(e for e in ledger if e.criterion == "PM1")
    pp3 = next(e for e in ledger if e.criterion == "PP3")
    assert pp3.fired and pp3.strength == "S"
    assert not pm1.fired and pm1.source == "suppressed"
    # PP3(+4) + PM2(+1) = 5 → VUS; in-silico alone no longer reaches LP.
    assert tier == "VUS"
