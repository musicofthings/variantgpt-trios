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


# ───────────────────────── FASTQ → aligned BAM (BWA-MEM) ─────────────────────────
#
# Upstream of the BAM path: when the raw data is FASTQ (not aligned), align it
# first. GATK best practice is BWA-MEM with a read group, then coordinate-sort.
# We use CLASSIC `bwa` by default — its ~5.5 GB human index fits an 8 GB machine;
# bwa-mem2 is faster but needs ~10 GB RAM. The reference must carry a BWA index
# (bwa index reference.fasta → .amb/.ann/.bwt/.pac/.sa) alongside the FASTA.


def index_reference_bwa(reference: Path, aligner: str = "bwa") -> None:
    """Build the BWA index next to the reference (one-time; ~1 h for the human
    genome). Produces reference.fasta.{amb,ann,bwt,pac,sa}."""
    _require(aligner)
    subprocess.run([aligner, "index", str(reference)], check=True)


def align_fastq(
    fastq_r1: Path,
    reference: Path,
    out_bam: Path,
    *,
    sample_id: str,
    fastq_r2: Optional[Path] = None,
    threads: int = 4,
    read_group: Optional[str] = None,
    aligner: str = "bwa",
) -> Path:
    """Align FASTQ(.gz) to the reference and emit a coordinate-sorted, indexed BAM.

    Paired-end when fastq_r2 is given (the usual case), else single-end. Streams
    BWA-MEM straight into `samtools sort` so the unsorted SAM never hits disk.
    A read group is attached (required by MarkDuplicates / HaplotypeCaller)."""
    _require(aligner)
    _require("samtools")
    out_bam.parent.mkdir(parents=True, exist_ok=True)
    rg = read_group or f"@RG\\tID:{sample_id}\\tSM:{sample_id}\\tPL:ILLUMINA\\tLB:{sample_id}"
    cmd = [aligner, "mem", "-t", str(threads), "-R", rg, str(reference), str(fastq_r1)]
    if fastq_r2 is not None:
        cmd.append(str(fastq_r2))
    aln = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    try:
        subprocess.run(
            ["samtools", "sort", "-@", str(threads), "-o", str(out_bam), "-"],
            stdin=aln.stdout, check=True,
        )
    finally:
        if aln.stdout is not None:
            aln.stdout.close()
        rc = aln.wait()
    if rc != 0:
        raise RuntimeError(f"{aligner} mem failed (exit {rc}) for sample {sample_id}")
    subprocess.run(["samtools", "index", str(out_bam)], check=True)
    return out_bam


def call_sample_vcf_from_fastq(
    fastq_r1: Path,
    reference: Path,
    work_dir: Path,
    *,
    sample_id: str,
    fastq_r2: Optional[Path] = None,
    known_sites: Optional[list[Path]] = None,
    intervals: Optional[Path] = None,
    do_bqsr: bool = True,
    threads: int = 4,
) -> Path:
    """FASTQ → analysis-ready VCF: BWA-MEM alignment, then the germline
    short-variant flow (MarkDuplicates → BQSR → HaplotypeCaller → GenotypeGVCFs)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    aligned = align_fastq(
        fastq_r1, reference, work_dir / f"{sample_id}.sorted.bam",
        sample_id=sample_id, fastq_r2=fastq_r2, threads=threads,
    )
    return call_sample_vcf(
        aligned, reference, work_dir, sample_id=sample_id,
        known_sites=known_sites, intervals=intervals, do_bqsr=do_bqsr,
    )


def call_all_from_fastq(
    fastq_paths: dict[str, tuple[Path, Optional[Path]]],
    reference: Path,
    work_dir: Path,
    *,
    known_sites: Optional[list[Path]] = None,
    intervals: Optional[Path] = None,
    do_bqsr: bool = True,
    threads: int = 4,
) -> dict[str, Path]:
    """Align + call every member's FASTQ → role→VCF, ready for joint.merge.
    fastq_paths maps role → (R1, R2|None)."""
    out: dict[str, Path] = {}
    for role, (r1, r2) in fastq_paths.items():
        out[role] = call_sample_vcf_from_fastq(
            r1, reference, work_dir / role, sample_id=role, fastq_r2=r2,
            known_sites=known_sites, intervals=intervals, do_bqsr=do_bqsr, threads=threads,
        )
    return out
