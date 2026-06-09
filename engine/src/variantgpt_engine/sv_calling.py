"""Structural-variant / CNV calling wrappers (PRD §4.x — SV pipeline).

Follows GATK best practices for germline CNVs (GATK gCNV) and, optionally,
Manta for balanced SVs (INV/INS/BND). Like liftover.py / normalize.py these are
thin subprocess wrappers: they run the real tools when present on PATH and raise
an informative error otherwise, so the rest of the SV pipeline (annotation +
ClinGen classification) can be exercised from a pre-called VCF in CI.

GATK gCNV germline best-practice flow (case mode against a prebuilt cohort model
/ panel of normals):

    1. PreprocessIntervals            — bin the reference into intervals
    2. CollectReadCounts              — per-sample read counts (.hdf5)
    3. (AnnotateIntervals/FilterIntervals — GC + mappability, done at PON build)
    4. DetermineGermlineContigPloidy  — CASE mode, against the ploidy model
    5. GermlineCNVCaller              — CASE mode, against the cohort CNV model
    6. PostprocessGermlineCNVCalls    — per-sample genotyped segment VCF

The cohort model + ploidy model + filtered intervals are built once from a panel
of normals (build_gcnv_pon, not run per case). This wrapper assumes they exist.
"""
from __future__ import annotations

import shutil
import subprocess
import tarfile
from pathlib import Path


def _require(tool: str) -> None:
    if not shutil.which(tool):
        raise RuntimeError(
            f"{tool} not on PATH — required for SV/CNV calling. "
            f"Install GATK (gatk) / Manta, or provide a pre-called SV VCF to the pipeline."
        )


def collect_read_counts(bam: Path, intervals: Path, out_hdf5: Path) -> Path:
    """GATK CollectReadCounts — per-sample read counts over preprocessed intervals."""
    _require("gatk")
    subprocess.run([
        "gatk", "CollectReadCounts", "-I", str(bam), "-L", str(intervals),
        "--interval-merging-rule", "OVERLAPPING_ONLY", "-O", str(out_hdf5),
    ], check=True)
    return out_hdf5


def call_gcnv_case(
    counts_hdf5: Path,
    ploidy_model: Path,
    cnv_model: Path,
    out_dir: Path,
    *,
    sample_id: str,
) -> Path:
    """Run the case-mode gCNV steps against a prebuilt cohort model and emit a
    genotyped segment VCF. Returns the path to the segments VCF.

    `ploidy_model` and `cnv_model` are the outputs of the panel-of-normals build
    (DetermineGermlineContigPloidy COHORT + GermlineCNVCaller COHORT)."""
    _require("gatk")
    out_dir.mkdir(parents=True, exist_ok=True)
    ploidy_calls = out_dir / "ploidy-case"
    subprocess.run([
        "gatk", "DetermineGermlineContigPloidy",
        "--model", str(ploidy_model),
        "-I", str(counts_hdf5),
        "-O", str(out_dir), "--output-prefix", "ploidy-case",
    ], check=True)
    gcnv_dir = out_dir / "gcnv-case"
    subprocess.run([
        "gatk", "GermlineCNVCaller", "--run-mode", "CASE",
        "--model", str(cnv_model),
        "-I", str(counts_hdf5),
        "--contig-ploidy-calls", str(ploidy_calls / "ploidy-case-calls"),
        "-O", str(out_dir), "--output-prefix", "gcnv-case",
    ], check=True)
    segments_vcf = out_dir / f"{sample_id}.gcnv.segments.vcf.gz"
    subprocess.run([
        "gatk", "PostprocessGermlineCNVCalls",
        "--model-shard-path", str(cnv_model),
        "--calls-shard-path", str(gcnv_dir),
        "--contig-ploidy-calls", str(ploidy_calls / "ploidy-case-calls"),
        "--sample-index", "0",
        "--output-genotyped-segments", str(segments_vcf),
        "--output-genotyped-intervals", str(out_dir / f"{sample_id}.gcnv.intervals.vcf.gz"),
    ], check=True)
    return segments_vcf


def call_manta(bam: Path, reference: Path, out_dir: Path) -> Path:
    """Run Manta for balanced/large SVs. Returns the diploid SV VCF."""
    _require("configManta.py")
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "configManta.py", "--bam", str(bam), "--referenceFasta", str(reference),
        "--runDir", str(out_dir),
    ], check=True)
    subprocess.run([str(out_dir / "runWorkflow.py"), "-m", "local", "-j", "4"], check=True)
    return out_dir / "results" / "variants" / "diploidSV.vcf.gz"


def annotate_with_annotsv(sv_vcf: Path, out_tsv: Path, *, genome_build: str = "GRCh38") -> Path:
    """Run AnnotSV on a called SV VCF, producing the annotated TSV that
    annotation_sources/annotsv.parse_tsv consumes."""
    _require("AnnotSV")
    build = "GRCh38" if "38" in genome_build else "GRCh37"
    subprocess.run([
        "AnnotSV", "-SVinputFile", str(sv_vcf), "-outputFile", str(out_tsv),
        "-genomeBuild", build,
    ], check=True)
    return out_tsv


def extract_model_bundle(tgz: Path, dest: Path) -> Path:
    """Unpack a gCNV cohort-model bundle (ploidy model + CNV model + filtered
    intervals, tarred at panel-of-normals build time) into `dest`. No external
    tool — pure-Python tarfile. Returns the extraction directory."""
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tgz, "r:*") as tar:
        # Guard against path traversal in the archive.
        for m in tar.getmembers():
            target = (dest / m.name).resolve()
            if not str(target).startswith(str(dest.resolve())):
                raise RuntimeError(f"unsafe path in gCNV model bundle: {m.name}")
        tar.extractall(dest)
    return dest


# ───────────────────────── panel-of-normals (cohort) build ─────────────────────────
#
# Run ONCE over a panel of normal BAMs to produce the cohort model the per-case
# CASE-mode caller (call_svs_from_bam) consumes. Output bundle layout matches
# extract_model_bundle's expectation: a tarball containing `ploidy-model/` and
# `cnv-model/`, plus the filtered interval list emitted alongside.


def preprocess_intervals(
    reference: Path, out_interval_list: Path,
    *, bin_length: int = 1000, padding: int = 0, targets: Path | None = None,
) -> Path:
    """GATK PreprocessIntervals. WGS: bin the genome (bin_length≈1000, padding 0).
    Exome/panel: pass `targets` (a BED/interval_list), bin_length 0, padding≈250."""
    _require("gatk")
    cmd = ["gatk", "PreprocessIntervals", "-R", str(reference),
           "--bin-length", str(bin_length), "--padding", str(padding),
           "--interval-merging-rule", "OVERLAPPING_ONLY", "-O", str(out_interval_list)]
    if targets is not None:
        cmd += ["-L", str(targets)]
    subprocess.run(cmd, check=True)
    return out_interval_list


def annotate_intervals(reference: Path, interval_list: Path, out_tsv: Path) -> Path:
    """GATK AnnotateIntervals — GC content (+ optional mappability) per interval."""
    _require("gatk")
    subprocess.run([
        "gatk", "AnnotateIntervals", "-R", str(reference), "-L", str(interval_list),
        "--interval-merging-rule", "OVERLAPPING_ONLY", "-O", str(out_tsv),
    ], check=True)
    return out_tsv


def filter_intervals(
    interval_list: Path, annotated_tsv: Path, counts: list[Path], out_interval_list: Path,
) -> Path:
    """GATK FilterIntervals — drop low-mappability / extreme-GC / low-count bins."""
    _require("gatk")
    cmd = ["gatk", "FilterIntervals", "-L", str(interval_list),
           "--annotated-intervals", str(annotated_tsv),
           "--interval-merging-rule", "OVERLAPPING_ONLY", "-O", str(out_interval_list)]
    for c in counts:
        cmd += ["-I", str(c)]
    subprocess.run(cmd, check=True)
    return out_interval_list


def determine_ploidy_cohort(
    counts: list[Path], contig_ploidy_priors: Path, intervals: Path, out_dir: Path,
    *, prefix: str = "ploidy",
) -> Path:
    """GATK DetermineGermlineContigPloidy COHORT mode → ploidy model dir.
    Returns the `{prefix}-model` directory."""
    _require("gatk")
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["gatk", "DetermineGermlineContigPloidy", "-L", str(intervals),
           "--interval-merging-rule", "OVERLAPPING_ONLY",
           "--contig-ploidy-priors", str(contig_ploidy_priors),
           "-O", str(out_dir), "--output-prefix", prefix]
    for c in counts:
        cmd += ["-I", str(c)]
    subprocess.run(cmd, check=True)
    return out_dir / f"{prefix}-model"


def germline_cnv_caller_cohort(
    counts: list[Path], intervals: Path, annotated_tsv: Path, ploidy_calls: Path, out_dir: Path,
    *, prefix: str = "cohort",
) -> Path:
    """GATK GermlineCNVCaller COHORT mode → CNV model dir. Returns `{prefix}-model`."""
    _require("gatk")
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = ["gatk", "GermlineCNVCaller", "--run-mode", "COHORT", "-L", str(intervals),
           "--interval-merging-rule", "OVERLAPPING_ONLY",
           "--annotated-intervals", str(annotated_tsv),
           "--contig-ploidy-calls", str(ploidy_calls),
           "-O", str(out_dir), "--output-prefix", prefix]
    for c in counts:
        cmd += ["-I", str(c)]
    subprocess.run(cmd, check=True)
    return out_dir / f"{prefix}-model"


def make_bundle(ploidy_model: Path, cnv_model: Path, out_tgz: Path) -> Path:
    """Tar the cohort ploidy + CNV models into the bundle CASE mode consumes,
    normalizing the in-archive names to `ploidy-model/` and `cnv-model/`
    (what extract_model_bundle + call_svs_from_bam expect)."""
    out_tgz.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out_tgz, "w:gz") as tar:
        tar.add(ploidy_model, arcname="ploidy-model")
        tar.add(cnv_model, arcname="cnv-model")
    return out_tgz


def build_gcnv_pon(
    reference: Path,
    normal_bams: list[Path],
    contig_ploidy_priors: Path,
    out_dir: Path,
    *,
    bin_length: int = 1000,
    padding: int = 0,
    targets: Path | None = None,
) -> tuple[Path, Path]:
    """One-shot panel-of-normals build. Returns (bundle.tgz, filtered_intervals).

    Upload the two outputs to R2 and point GCNV_MODEL_TGZ_KEY / GCNV_INTERVALS_KEY
    at them; per-case CASE-mode calling (call_svs_from_bam) then runs against this
    model. Pass `targets` (+ bin_length=0, padding≈250) for exome/panel; leave it
    unset for WGS binning."""
    _require("gatk")
    out_dir.mkdir(parents=True, exist_ok=True)
    preprocessed = preprocess_intervals(
        reference, out_dir / "preprocessed.interval_list",
        bin_length=bin_length, padding=padding, targets=targets,
    )
    annotated = annotate_intervals(reference, preprocessed, out_dir / "annotated.tsv")
    counts: list[Path] = []
    for i, bam in enumerate(normal_bams):
        counts.append(collect_read_counts(bam, preprocessed, out_dir / f"normal_{i}.counts.hdf5"))
    filtered = filter_intervals(preprocessed, annotated, counts, out_dir / "filtered.interval_list")
    ploidy_dir = out_dir / "ploidy"
    ploidy_model = determine_ploidy_cohort(counts, contig_ploidy_priors, filtered, ploidy_dir)
    cnv_model = germline_cnv_caller_cohort(
        counts, filtered, annotated, ploidy_dir / "ploidy-calls", out_dir / "cnv",
    )
    bundle = make_bundle(ploidy_model, cnv_model, out_dir / "gcnv_pon.tgz")
    return bundle, filtered


def call_svs_from_bam(
    bam: Path,
    reference: Path,
    intervals: Path,
    ploidy_model: Path,
    cnv_model: Path,
    out_dir: Path,
    *,
    sample_id: str,
    genome_build: str = "GRCh38",
) -> Path:
    """End-to-end germline CNV calling for one BAM → annotated AnnotSV TSV.

    CollectReadCounts → gCNV CASE (ploidy + caller + postprocess) → segments VCF
    → AnnotSV. The returned TSV is exactly what sv_pipeline.run_sv_from_annotsv
    consumes. `ploidy_model`/`cnv_model`/`intervals` come from the prebuilt
    panel-of-normals bundle (extract_model_bundle)."""
    _require("gatk")
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = collect_read_counts(bam, intervals, out_dir / f"{sample_id}.counts.hdf5")
    segments = call_gcnv_case(counts, ploidy_model, cnv_model, out_dir, sample_id=sample_id)
    return annotate_with_annotsv(
        segments, out_dir / f"{sample_id}.annotsv.tsv", genome_build=genome_build,
    )
