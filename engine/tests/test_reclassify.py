"""Reclassification tests (PRD §8): seed variants common in SAS but rare global."""
from __future__ import annotations

from variantgpt_engine.models import EvidenceItem, PopulationAF, Variant
from variantgpt_engine.reclassify import reclassify


def _vus_with_pm2():
    return Variant(
        id="chr1:100:A:T", chrom="chr1", pos=100, ref="A", alt="T",
        baseline_tier="VUS", baseline_points=1,
        evidence=[
            EvidenceItem(criterion="PM2", fired=True, strength="P", points=1,
                         source="gnomad_v4_global", detail="rare globally"),
        ],
        populations=[
            PopulationAF(source="gnomad_v4_global", af=0.0),
            PopulationAF(source="gnomad_v4_sas", af=0.03),  # > BS1 0.01
            PopulationAF(source="indigenomes", af=0.04),
        ],
    )


def test_pm2_retracted_and_bs1_fires_for_sas_common_variant():
    v = _vus_with_pm2()
    result = reclassify(v, snapshot_versions={"engine": "0.1.0"})
    assert result is not None
    proposal, _ = result
    assert proposal.from_tier == "VUS"
    assert proposal.to_tier in ("LB", "B")
    criteria = {c.criterion for c in proposal.changed_criteria}
    assert "PM2" in criteria  # retracted
    assert "BS1" in criteria or "BA1" in criteria
    # BS1 must not double-fire across multiple SAS sources.
    bs1_rows = [c for c in proposal.changed_criteria if c.criterion == "BS1" and c.fired]
    assert len(bs1_rows) <= 1


def test_proposal_never_auto_commits():
    v = _vus_with_pm2()
    result = reclassify(v, snapshot_versions={})
    assert result is not None
    proposal, _ = result
    assert proposal.status == "pending"


def test_ba1_fires_above_5_percent():
    v = _vus_with_pm2()
    v.populations[1].af = 0.07
    result = reclassify(v, snapshot_versions={})
    assert result is not None
    proposal, _ = result
    assert proposal.to_tier == "B"
