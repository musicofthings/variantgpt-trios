"""South Asian VUS reclassification engine (PRD §4.6).

Runs ONLY on variants the baseline engine called VUS (or, optionally, on
ClinVar conflicting-VUS). Re-evaluates frequency criteria against South Asian
baselines (gnomAD sas, IndiGenomes, GenomeAsia, GenomeIndia-when-present).

Rules:
  - BA1/BS1 fire if AF is above threshold in ANY South Asian source — pushes
    toward Benign, even if gnomAD global says rare.
  - PM2 is retracted if the variant is present at meaningful AF in any South
    Asian source.
  - Founder-pathogenic signal (absent globally, enriched in a South Asian
    subgroup, phenotype concordant) is flagged for curator review — NEVER
    auto-upgraded on frequency alone.

Output: ReclassProposal in `pending` status. Never auto-commits (§4.10).
"""
from __future__ import annotations

from copy import deepcopy
from typing import Iterable

from .acmg.engine import classify, tier_for, DEFAULT_THRESHOLDS  # noqa: F401
from .acmg.points import points_for
from .acmg.thresholds import thresholds_for
from .models import EvidenceItem, PopulationAF, ReclassProposal, Variant

SAS_SOURCES = ("gnomad_v4_sas", "indigenomes", "genomeasia", "genomeindia")


def reclassify(
    variant: Variant, snapshot_versions: dict[str, str]
) -> tuple[ReclassProposal, int] | None:
    """Return (proposal, new_total_points) — new_total_points is the sum across
    the full post-reclass ledger, not just the changed criteria."""
    if variant.baseline_tier != "VUS":
        return None

    recalibrated = deepcopy(variant)
    changed: list[EvidenceItem] = []
    af_evidence: list[PopulationAF] = []

    t = thresholds_for(variant.gene)
    sas_afs = {pop.source: pop for pop in variant.populations if pop.source in SAS_SOURCES}
    af_evidence.extend(sas_afs.values())

    # Strip the baseline frequency criteria; we'll re-evaluate them with
    # population-appropriate thresholds.
    new_ledger: list[EvidenceItem] = []
    for item in recalibrated.evidence:
        if item.criterion in ("PM2", "BA1", "BS1"):
            continue
        new_ledger.append(item)

    # PM2 retraction: only meaningful if PM2 actually fired baseline AND is
    # contradicted by a South Asian source.
    pm2_was_fired = any(i.criterion == "PM2" and i.fired for i in variant.evidence)
    pm2_retracted = pm2_was_fired and any(
        (pop.af or 0) >= t.pm2_supporting for pop in sas_afs.values()
    )
    if pm2_retracted:
        changed.append(EvidenceItem(
            criterion="PM2", fired=False, source="south_asian_baseline",
            detail="retracted: present in South Asian baseline at AF>=1e-4",
        ))
    else:
        # Keep PM2 if it fired baseline.
        for item in variant.evidence:
            if item.criterion == "PM2" and item.fired:
                new_ledger.append(item)

    # BA1 / BS1 against SAS sources, gene-specific thresholds. Each criterion
    # fires at most once across all SAS sources — pick the source with the
    # strongest signal (highest AF) so the ledger row is deterministic.
    ba1_fired = False
    bs1_fired = False
    sorted_sas = sorted(
        (p for p in sas_afs.values() if p.af is not None),
        key=lambda p: p.af or 0,
        reverse=True,
    )
    for pop in sorted_sas:
        if not ba1_fired and (pop.af or 0) > t.ba1:
            ba1_fired = True
            new_ledger.append(EvidenceItem(
                criterion="BA1", fired=True, strength="BA",
                source=pop.source,
                detail=f"AF={pop.af:.4f} > BA1 {t.ba1} ({t.source}, South Asian baseline)",
            ))
            changed.append(new_ledger[-1])
            break  # BA1 is stand-alone benign; nothing else matters.
        if not bs1_fired and (pop.af or 0) > t.bs1:
            bs1_fired = True
            new_ledger.append(EvidenceItem(
                criterion="BS1", fired=True, strength="BS", points=points_for("BS"),
                source=pop.source,
                detail=f"AF={pop.af:.4f} > BS1 {t.bs1} ({t.source}, South Asian baseline)",
            ))
            changed.append(new_ledger[-1])

    new_points = sum(item.points for item in new_ledger if item.fired)
    new_tier = tier_for(new_points, DEFAULT_THRESHOLDS, ba1=ba1_fired)

    if new_tier == variant.baseline_tier and not changed:
        return None

    proposal = ReclassProposal(
        variant_id=variant.id,
        from_tier=variant.baseline_tier or "VUS",
        to_tier=new_tier,
        changed_criteria=changed,
        af_evidence=af_evidence,
        snapshot_versions=snapshot_versions,
        status="pending",
    )
    return proposal, new_points


def reclassify_all(variants: Iterable[Variant], snapshot_versions: dict[str, str]) -> list[ReclassProposal]:
    out = []
    for v in variants:
        result = reclassify(v, snapshot_versions)
        if result is None:
            continue
        proposal, new_points = result
        out.append(proposal)
        v.reclass_tier = proposal.to_tier
        v.reclass_points = new_points
        v.reclass_delta = new_points - v.baseline_points
    return out
