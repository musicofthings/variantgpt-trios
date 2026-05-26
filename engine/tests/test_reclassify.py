"""Reclassification tests (PRD §8): seed variants common in SAS but rare global."""
from __future__ import annotations

from variantgpt_engine.models import EvidenceItem, PopulationAF, Variant
from variantgpt_engine.reclassify import reclassify


def _vus_with_pm2():
    """A VUS with a fired PM2 (rare globally) that we expect the SAS
    reclassification step to retract because IndiGenomes shows the variant
    is common in Indian samples. gnomad_v4_sas is no longer used by the
    reclass engine; only Indian-cohort sources count."""
    return Variant(
        id="chr1:100:A:T", chrom="chr1", pos=100, ref="A", alt="T",
        baseline_tier="VUS", baseline_points=1,
        evidence=[
            EvidenceItem(criterion="PM2", fired=True, strength="P", points=1,
                         source="gnomad_v4_global", detail="rare globally"),
        ],
        populations=[
            PopulationAF(source="gnomad_v4_global", af=0.0),
            PopulationAF(source="indigenomes", af=0.04),  # > BS1 0.01
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
    """When IndiGen AF exceeds 5% (BA1 threshold), the variant flips Benign."""
    v = _vus_with_pm2()
    # Bump IndiGen above the BA1 stand-alone benign threshold.
    for pop in v.populations:
        if pop.source == "indigenomes":
            pop.af = 0.07
    result = reclassify(v, snapshot_versions={})
    assert result is not None
    proposal, _ = result
    assert proposal.to_tier == "B"
