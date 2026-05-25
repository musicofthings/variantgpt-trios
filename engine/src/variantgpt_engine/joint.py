"""Joint genotype matrix construction (PRD §4.3).

Build a per-variant joint view keyed by (chrom, pos, ref, alt) across the
pedigree's members. Genotypes are stored as 0/1/2 (alt count) with `None`
for missing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class JointVariant:
    chrom: str
    pos: int
    ref: str
    alt: str
    genotypes: dict[str, Optional[int]] = field(default_factory=dict)  # member_id -> 0/1/2/None
    depths: dict[str, Optional[int]] = field(default_factory=dict)
    allele_balance: dict[str, Optional[float]] = field(default_factory=dict)
    filters: dict[str, str] = field(default_factory=dict)

    @property
    def key(self) -> tuple[str, int, str, str]:
        return (self.chrom, self.pos, self.ref, self.alt)


def merge(member_vcfs: dict[str, Path]) -> list[JointVariant]:
    """Stream per-member VCFs and build a joint matrix.

    Prefers cyvcf2 (handles bgzipped + multiallelic correctly); falls back to a
    pure-Python parser for uncompressed biallelic VCFs so the demo path runs
    on Windows boxes without htslib installed.
    """
    try:
        from cyvcf2 import VCF  # type: ignore
    except ImportError:
        return _merge_pure_python(member_vcfs)

    table: dict[tuple[str, int, str, str], JointVariant] = {}
    for member_id, vcf_path in member_vcfs.items():
        for rec in VCF(str(vcf_path)):
            for alt in rec.ALT:
                key = (str(rec.CHROM), int(rec.POS), str(rec.REF), str(alt))
                jv = table.setdefault(
                    key,
                    JointVariant(chrom=key[0], pos=key[1], ref=key[2], alt=key[3]),
                )
                gt = rec.gt_types[0] if len(rec.gt_types) else 3  # cyvcf2: 0=HOM_REF,1=HET,2=UNKNOWN,3=HOM_ALT
                jv.genotypes[member_id] = _gt_alt_count(gt)
                if rec.gt_depths is not None and len(rec.gt_depths):
                    jv.depths[member_id] = int(rec.gt_depths[0])
                if rec.FILTER:
                    jv.filters[member_id] = str(rec.FILTER)
    return list(table.values())


def _merge_pure_python(member_vcfs: dict[str, Path]) -> list[JointVariant]:
    """Minimal VCF v4.2 reader — uncompressed, biallelic, single-sample.

    Sufficient for the curated demo trio (data/test/demo_trio). Real cases must
    route through cyvcf2 + bcftools norm; this is explicitly a demo-only path.
    """
    table: dict[tuple[str, int, str, str], JointVariant] = {}
    for member_id, vcf_path in member_vcfs.items():
        with open(vcf_path, "r", encoding="utf-8") as fh:
            format_idx: dict[str, int] = {}
            for raw in fh:
                line = raw.rstrip("\n")
                if not line or line.startswith("##"):
                    continue
                if line.startswith("#CHROM"):
                    continue
                cols = line.split("\t")
                if len(cols) < 10:
                    continue
                chrom, pos, _id, ref, alt, _qual, filt, _info, fmt, sample = cols[:10]
                # The synthetic demo emits one ALT per row; skip multiallelic safety.
                if "," in alt:
                    continue
                key = (chrom, int(pos), ref, alt)
                jv = table.setdefault(
                    key,
                    JointVariant(chrom=chrom, pos=int(pos), ref=ref, alt=alt),
                )
                # Parse FORMAT / SAMPLE.
                fmt_keys = fmt.split(":")
                fmt_vals = sample.split(":")
                format_idx = {k: i for i, k in enumerate(fmt_keys)}
                gt_str = fmt_vals[format_idx.get("GT", 0)] if fmt_vals else "./."
                jv.genotypes[member_id] = _parse_gt(gt_str)
                if "DP" in format_idx and format_idx["DP"] < len(fmt_vals):
                    try:
                        jv.depths[member_id] = int(fmt_vals[format_idx["DP"]])
                    except ValueError:
                        pass
                if filt and filt != "PASS":
                    jv.filters[member_id] = filt
    return list(table.values())


def _parse_gt(gt: str) -> Optional[int]:
    """Convert a VCF GT string into alt-allele count (0/1/2). None if missing."""
    if not gt or gt in ("./.", ".|.", "."):
        return None
    sep = "/" if "/" in gt else ("|" if "|" in gt else None)
    if sep is None:
        # Hemizygous (X/Y in male): single allele.
        return 0 if gt == "0" else (1 if gt == "1" else None)
    parts = gt.split(sep)
    try:
        ints = [int(p) for p in parts if p != "."]
    except ValueError:
        return None
    if not ints:
        return None
    return sum(1 for x in ints if x > 0)


def _gt_alt_count(cyvcf2_gt: int) -> Optional[int]:
    # cyvcf2.gt_types: 0=HOM_REF, 1=HET, 2=UNKNOWN, 3=HOM_ALT
    return {0: 0, 1: 1, 3: 2}.get(cyvcf2_gt)
