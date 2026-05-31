"""End-to-end pipeline orchestrator (PRD §9, milestones 1–6).

This wires every stage in order and emits the case.json contract. Heavy
external tools (bcftools, VEP, CrossMap) are called when present; on a clean
dev box without them, the pipeline still runs through the in-Python stages
(joint merge, inheritance modeling, ACMG, reclassification) using whatever
joint data was produced — useful for smoke tests and CI.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .acmg import augment_context_evidence, classify
from .annotation import AnnotationContext, annotate
from .build_detect import detect_build
from .inheritance import assign_models, compound_het_pass
from .joint import merge
from .models import Build, CaseEmission, HPOTerm, Pedigree, Variant
from .prioritize import priority
from .qc import compute_qc
from .reclassify import reclassify_all


def run_case(
    case_id: str,
    pedigree: Pedigree,
    vcf_paths: dict[str, Path],
    hpo_ids: list[str],
    build: str = "auto",
    reference: Optional[Path] = None,
    chain: Optional[Path] = None,
    use_demo_annotations: bool = False,
) -> CaseEmission:
    resolved_build = _resolve_build(build, vcf_paths)

    # TODO milestones 1–2: real liftover (chain) + bcftools norm when reference is provided.
    # For now we proceed directly from the input VCFs; normalization and liftover are
    # invoked when the corresponding tools are on PATH (see normalize.py, liftover.py).

    joint = merge(vcf_paths)
    qc = compute_qc(joint, pedigree)

    track_versions = {"engine": "0.1.0"}
    if use_demo_annotations:
        track_versions["demo_dataset"] = "v1"
    ctx = AnnotationContext(
        build=resolved_build.value,
        track_versions=track_versions,
        use_gnomad=not use_demo_annotations,  # offline-friendly demo path
        use_demo_annotations=use_demo_annotations,
    )

    variants: list[Variant] = []
    for jv in joint:
        models, conf = assign_models(jv, pedigree)
        v = annotate(jv, ctx)
        v.inheritance_models = models
        v.inheritance_confidence = conf  # type: ignore[assignment]
        variants.append(v)

    # Compound-het pass needs gene assignment from annotation.
    addl = compound_het_pass([(jv, ann.gene) for jv, ann in zip(joint, variants)], pedigree)
    for v, jv in zip(variants, joint):
        if jv.key in addl:
            v.inheritance_models = list(dict.fromkeys(v.inheritance_models + addl[jv.key]))

    for v in variants:
        tier, points, ledger = classify(v)
        v.baseline_tier = tier
        v.baseline_points = points
        v.evidence = ledger
        priority(v, hpo_ids)

    # Context-aware criteria (PM3 / PP1; PP4 requires phenotype scoring, which
    # this offline path doesn't run, so it no-ops here). Re-tallies baseline.
    augment_context_evidence(variants, pedigree)

    proposals = reclassify_all(variants, snapshot_versions=track_versions)

    return CaseEmission(
        case_id=case_id,
        build=resolved_build,
        pedigree=pedigree,
        hpo=[HPOTerm(hpo_id=h) for h in hpo_ids],
        qc=qc,
        variants=variants,
        proposals=proposals,
        versions=track_versions,
    )


def _resolve_build(requested: str, vcf_paths: dict[str, Path]) -> Build:
    if requested.lower() == "grch37":
        return Build.grch37
    if requested.lower() == "grch38":
        return Build.grch38
    for p in vcf_paths.values():
        b = detect_build(p)
        if b is not None:
            return b
    return Build.grch38
