"""End-to-end pipeline orchestrator (PRD §9, milestones 1–6).

This wires every stage in order and emits the case.json contract. Inputs may be
per-member VCFs or aligned BAM/CRAM (the latter is called with GATK best
practices first — see bam_calling.py). Heavy external tools (GATK, bcftools,
VEP, CrossMap, AnnotSV) are invoked when present on PATH; the in-Python stages
(joint merge, inheritance, ACMG, reclassification, CNV classification) always
run on whatever upstream data exists.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .acmg import augment_context_evidence, classify
from .acmg.concordance import assess_all, assess_svs
from .annotation import AnnotationContext, annotate
from .bam_calling import call_all
from .build_detect import detect_build
from .inheritance import assign_models, compound_het_pass
from .joint import merge
from .models import Build, CaseEmission, HPOTerm, MemberCall, Pedigree, StructuralVariant, Variant
from .prioritize import priority
from .qc import compute_qc
from .reclassify import reclassify_all
from .sv_pipeline import run_sv_from_annotsv


def run_case(
    case_id: str,
    pedigree: Pedigree,
    vcf_paths: Optional[dict[str, Path]] = None,
    hpo_ids: Optional[list[str]] = None,
    build: str = "auto",
    reference: Optional[Path] = None,
    chain: Optional[Path] = None,
    sv_annotsv_tsv: Optional[Path] = None,
    sv_calls_by_sv: Optional[dict[str, list[MemberCall]]] = None,
    bam_paths: Optional[dict[str, Path]] = None,
    work_dir: Optional[Path] = None,
    known_sites: Optional[list[Path]] = None,
    intervals: Optional[Path] = None,
) -> CaseEmission:
    hpo_ids = hpo_ids or []

    # Aligned-reads path: call per-member VCFs from BAM/CRAM with GATK best
    # practices, then continue exactly as the VCF path does. Requires a reference.
    if bam_paths:
        if reference is None:
            raise ValueError("bam_paths supplied but no reference FASTA — GATK calling needs --reference")
        wd = work_dir or Path(f".variantgpt_work/{case_id}")
        vcf_paths = call_all(bam_paths, reference, wd / "calls",
                             known_sites=known_sites, intervals=intervals)
    if not vcf_paths:
        raise ValueError("run_case requires either vcf_paths or bam_paths")

    resolved_build = _resolve_build(build, vcf_paths)

    joint = merge(vcf_paths)
    qc = compute_qc(joint, pedigree)

    track_versions = {"engine": "0.1.0"}
    if bam_paths:
        track_versions["caller"] = "gatk-haplotypecaller"
    ctx = AnnotationContext(
        build=resolved_build.value,
        track_versions=track_versions,
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

    # Surface engine-vs-ClinVar disagreements for curator review (never auto-overrides).
    assess_all(variants)

    # Structural / copy-number variants (PRD §4.x). Runs from a pre-annotated
    # AnnotSV TSV; calling (GATK gCNV / Manta) happens upstream in sv_calling.
    structural_variants: list[StructuralVariant] = []
    if sv_annotsv_tsv is not None:
        track_versions["sv_classifier"] = "clingen-2019"
        structural_variants = run_sv_from_annotsv(sv_annotsv_tsv, pedigree, sv_calls_by_sv)
        assess_svs(structural_variants)

    return CaseEmission(
        case_id=case_id,
        build=resolved_build,
        pedigree=pedigree,
        hpo=[HPOTerm(hpo_id=h) for h in hpo_ids],
        qc=qc,
        variants=variants,
        structural_variants=structural_variants,
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
