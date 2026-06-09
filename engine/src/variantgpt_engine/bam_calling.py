"""Germline variant calling from aligned BAM/CRAM (GATK best practices).

The clinical pipeline historically accepted per-member VCFs. This module adds
the upstream step so the engine can ingest aligned reads directly: it runs the
GATK germline short-variant best-practice flow to produce a per-sample VCF that
the existing pipeline (joint merge → annotate → ACMG) consumes unchanged.

Best-practice flow (per sample, assuming an analysis-ready aligned BAM/CRAM —
i.e. already aligned with BWA-MEM and coordinate-sorted):

    1. MarkDuplicates                 — flag PCR/optical duplicates
    2. BaseRecalibrator + ApplyBQSR   — base quality score recalibration
    3. HaplotypeCaller (-ERC GVCF)    — per-sample GVCF
    4. GenotypeGVCFs                  — genotype to a single-sample VCF

CNV/SV calling from the same BAM is handled by sv_calling.py (GATK gCNV / Manta).

Like liftover.py / normalize.py / sv_calling.py these are thin subprocess
wrappers: they run the real tools when present on PATH and raise an informative
error otherwise. Inputs are large (multi-GB BAM/CRAM); nothing is read into
memory here — every step streams through GATK to disk.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional


def _require(tool: str) -> None:
    if not shutil.which(tool):
        raise RuntimeError(
            f"{tool} not on PATH — required for BAM variant calling. "
            f"Install GATK (gatk), or provide a per-member VCF instead of a BAM."
        )


def mark_duplicates(bam: Path, out_bam: Path, metrics: Optional[Path] = None) -> Path:
    _require("gatk")
    subprocess.run([
        "gatk", "MarkDuplicates", "-I", str(bam), "-O", str(out_bam),
        "-M", str(metrics or out_bam.with_suffix(".dup_metrics.txt")),
    ], check=True)
    return out_bam


def bqsr(bam: Path, reference: Path, known_sites: list[Path], out_bam: Path) -> Path:
    """BaseRecalibrator + ApplyBQSR. `known_sites` are dbSNP/Mills/1000G VCFs."""
    _require("gatk")
    table = out_bam.with_suffix(".recal.table")
    cmd = ["gatk", "BaseRecalibrator", "-I", str(bam), "-R", str(reference), "-O", str(table)]
    for ks in known_sites:
        cmd += ["--known-sites", str(ks)]
    subprocess.run(cmd, check=True)
    subprocess.run([
        "gatk", "ApplyBQSR", "-I", str(bam), "-R", str(reference),
        "--bqsr-recal-file", str(table), "-O", str(out_bam),
    ], check=True)
    return out_bam


def haplotype_caller(bam: Path, reference: Path, out_gvcf: Path, intervals: Optional[Path] = None) -> Path:
    _require("gatk")
    cmd = ["gatk", "HaplotypeCaller", "-I", str(bam), "-R", str(reference),
           "-O", str(out_gvcf), "-ERC", "GVCF"]
    if intervals is not None:
        cmd += ["-L", str(intervals)]
    subprocess.run(cmd, check=True)
    return out_gvcf


def genotype_gvcf(gvcf: Path, reference: Path, out_vcf: Path) -> Path:
    _require("gatk")
    subprocess.run([
        "gatk", "GenotypeGVCFs", "-R", str(reference), "-V", str(gvcf), "-O", str(out_vcf),
    ], check=True)
    return out_vcf


def call_sample_vcf(
    bam: Path,
    reference: Path,
    work_dir: Path,
    *,
    sample_id: str,
    known_sites: Optional[list[Path]] = None,
    intervals: Optional[Path] = None,
    do_bqsr: bool = True,
) -> Path:
    """Run the full germline short-variant flow on one BAM and return the VCF.

    BQSR is skipped when no known-sites resources are supplied (do_bqsr=False or
    empty known_sites) — recalibration without resources is worse than none.
    """
    _require("gatk")
    work_dir.mkdir(parents=True, exist_ok=True)
    dedup = mark_duplicates(bam, work_dir / f"{sample_id}.dedup.bam")
    analysis_ready = dedup
    if do_bqsr and known_sites:
        analysis_ready = bqsr(dedup, reference, known_sites, work_dir / f"{sample_id}.recal.bam")
    gvcf = haplotype_caller(analysis_ready, reference, work_dir / f"{sample_id}.g.vcf.gz", intervals)
    vcf = genotype_gvcf(gvcf, reference, work_dir / f"{sample_id}.vcf.gz")
    return vcf


def call_all(
    bam_paths: dict[str, Path],
    reference: Path,
    work_dir: Path,
    *,
    known_sites: Optional[list[Path]] = None,
    intervals: Optional[Path] = None,
    do_bqsr: bool = True,
) -> dict[str, Path]:
    """Call every member BAM → VCF. Returns role→vcf, ready for joint.merge."""
    out: dict[str, Path] = {}
    for role, bam in bam_paths.items():
        out[role] = call_sample_vcf(
            bam, reference, work_dir / role, sample_id=role,
            known_sites=known_sites, intervals=intervals, do_bqsr=do_bqsr,
        )
    return out
