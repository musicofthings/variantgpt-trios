"""Preprocessor sanity tests — every documented step has a corresponding case."""
from __future__ import annotations

from pathlib import Path

from variantgpt_engine.preprocess import (
    PreprocessConfig, _normalize_chrom, _trim_alleles, _reduce_gt_for_alt,
    preprocess_vcf,
)


HEADER = (
    "##fileformat=VCFv4.2\n"
    "##FILTER=<ID=LowQual,Description=\"bad\">\n"
    "##INFO=<ID=DP,Number=1,Type=Integer,Description=\"dp\">\n"
    "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"gt\">\n"
    "##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"dp\">\n"
    "##FORMAT=<ID=GQ,Number=1,Type=Integer,Description=\"gq\">\n"
    "##FORMAT=<ID=AD,Number=R,Type=Integer,Description=\"ad\">\n"
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tSAMPLE\n"
)


def _write(path: Path, body: str) -> None:
    path.write_text(HEADER + body, encoding="utf-8")


def test_trims_shared_prefix_and_suffix():
    ref, alt, pos = _trim_alleles("ATG", "ATC", 100)
    assert (ref, alt, pos) == ("G", "C", 102)


def test_normalize_chrom_modes():
    assert _normalize_chrom("1", "chr") == "chr1"
    assert _normalize_chrom("chr1", "chr") == "chr1"
    assert _normalize_chrom("CHR1", "chr") == "chr1"
    assert _normalize_chrom("chr1", "") == "1"
    assert _normalize_chrom("MT", "chr") == "chrM"
    assert _normalize_chrom("chrM", "") == "M"
    assert _normalize_chrom("X", "chr") == "chrX"


def test_reduce_gt_multiallelic():
    assert _reduce_gt_for_alt("0/2", target_alt_idx=2, num_alts=2) == "0/1"
    assert _reduce_gt_for_alt("0/2", target_alt_idx=1, num_alts=2) == "0/0"
    assert _reduce_gt_for_alt("1/2", target_alt_idx=1, num_alts=2) == "1/0"
    assert _reduce_gt_for_alt("./.", 1, 1) == "./."


def test_drops_filtered_records(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(inp, "chr1\t100\t.\tA\tT\t40\tLowQual\t.\tGT:DP:GQ\t0/1:30:50\n")
    rep = preprocess_vcf(inp, out)
    assert rep.dropped_filtered == 1
    assert rep.output_records == 0


def test_drops_low_qual(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(inp, "chr1\t100\t.\tA\tT\t10\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n")
    rep = preprocess_vcf(inp, out)
    assert rep.dropped_low_qual == 1


def test_gt_low_gq_becomes_missing(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(inp, "chr1\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:5\n")
    rep = preprocess_vcf(inp, out, config=PreprocessConfig(drop_hom_ref=False))
    body = out.read_text()
    assert "./." in body
    assert rep.gt_filtered_low_gq == 1


def test_multiallelic_split(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(inp, "chr1\t100\t.\tA\tT,C\t40\tPASS\t.\tGT:DP:GQ\t1/2:30:50\n")
    rep = preprocess_vcf(inp, out)
    data_rows = [l for l in out.read_text().splitlines() if not l.startswith("#")]
    assert len(data_rows) == 2
    assert rep.multi_allelic_split == 1


def test_dedup(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(
        inp,
        "chr1\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n"
        "chr1\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n",
    )
    rep = preprocess_vcf(inp, out)
    assert rep.dropped_duplicate == 1
    assert rep.output_records == 1


def test_drops_hom_ref(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(inp, "chr1\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/0:30:50\n")
    rep = preprocess_vcf(inp, out)
    assert rep.dropped_hom_ref == 1


def test_sort_and_chrom_normalize(tmp_path: Path):
    inp = tmp_path / "in.vcf"; out = tmp_path / "out.vcf"
    _write(
        inp,
        "2\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n"
        "1\t200\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n"
        "1\t100\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n"
        "X\t1\t.\tA\tT\t40\tPASS\t.\tGT:DP:GQ\t0/1:30:50\n",
    )
    rep = preprocess_vcf(inp, out)
    chroms = [l.split("\t")[0] for l in out.read_text().splitlines() if not l.startswith("#")]
    assert chroms == ["chr1", "chr1", "chr2", "chrX"]
    assert rep.output_records == 4
