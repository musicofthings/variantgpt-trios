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

    # VEP CSQ — one dict per transcript annotation, keys from the CSQ format
    # header (Allele, Consequence, IMPACT, SYMBOL, Gene, Feature, HGVSc, HGVSp,
    # CANONICAL, MANE_SELECT, ...). Empty when the input VCF wasn't VEP-annotated.
    csq: list[dict[str, str]] = field(default_factory=list)

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
        vcf = VCF(str(vcf_path))
        csq_fields: list[str] | None = None
        for hdr in vcf.header_iter():
            try:
                info = hdr.info(extra=True)
            except Exception:  # noqa: BLE001
                continue
            if info.get("ID") == "CSQ" and "Description" in info:
                csq_fields = _parse_csq_format(f"##INFO=<{info['Description']}>")
                break
        for rec in vcf:
            csq_raw = ""
            try:
                csq_raw = rec.INFO.get("CSQ") or ""
            except KeyError:
                pass
            csq_per_alt = _parse_csq(csq_raw, csq_fields) if csq_fields and csq_raw else {}
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
                if csq_per_alt and not jv.csq:
                    matches = csq_per_alt.get(str(alt), []) or csq_per_alt.get(_csq_allele(str(rec.REF), str(alt)), [])
                    if matches:
                        jv.csq = matches
    return list(table.values())


def _merge_pure_python(member_vcfs: dict[str, Path]) -> list[JointVariant]:
    """Minimal VCF v4.2 reader — uncompressed, biallelic, single-sample.

    Captures: genotypes, depths, FILTER, and the VEP CSQ INFO field if the VCF
    was VEP-annotated. CSQ is parsed using the format declared in the
    ``##INFO=<ID=CSQ,...,Format=...>`` header line, so any pipe-delimited field
    layout works.

    Sufficient for the curated demo trio AND for VEP-annotated clinical VCFs.
    Multi-allelic sites are split on commas before keying.
    """
    table: dict[tuple[str, int, str, str], JointVariant] = {}
    for member_id, vcf_path in member_vcfs.items():
        with open(vcf_path, "r", encoding="utf-8") as fh:
            csq_fields: list[str] | None = None
            for raw in fh:
                line = raw.rstrip("\n")
                if not line:
                    continue
                if line.startswith("##"):
                    # Capture CSQ format declaration (once).
                    if csq_fields is None and line.startswith("##INFO=<ID=CSQ"):
                        csq_fields = _parse_csq_format(line)
                    continue
                if line.startswith("#CHROM"):
                    continue
                cols = line.split("\t")
                if len(cols) < 10:
                    continue
                chrom, pos, _id, ref, alt, _qual, filt, info, fmt, sample = cols[:10]
                fmt_keys = fmt.split(":")
                fmt_vals = sample.split(":")
                format_idx = {k: i for i, k in enumerate(fmt_keys)}
                gt_str = fmt_vals[format_idx.get("GT", 0)] if fmt_vals else "./."
                gt = _parse_gt(gt_str)
                try:
                    dp_val = int(fmt_vals[format_idx["DP"]]) if "DP" in format_idx else None
                except (ValueError, IndexError):
                    dp_val = None

                info_kv = _parse_info(info)
                csq_per_alt: dict[str, list[dict[str, str]]] = {}
                if csq_fields and "CSQ" in info_kv:
                    csq_per_alt = _parse_csq(info_kv["CSQ"], csq_fields)

                # Iterate ALT alleles — supports multi-allelic sites natively.
                for alt_idx, alt_allele in enumerate(alt.split(",")):
                    key = (chrom, int(pos), ref, alt_allele)
                    jv = table.setdefault(
                        key,
                        JointVariant(chrom=chrom, pos=int(pos), ref=ref, alt=alt_allele),
                    )
                    # For multi-allelic GT (e.g. "0/2"), reduce to alt-count for *this* alt index.
                    jv.genotypes[member_id] = _alt_count_for(gt_str, alt_idx + 1) if "," in alt else gt
                    if dp_val is not None:
                        jv.depths[member_id] = dp_val
                    if filt and filt != "PASS":
                        jv.filters[member_id] = filt
                    if csq_per_alt:
                        # Match CSQ entries by Allele field (VEP key on the alt sequence).
                        matches = csq_per_alt.get(alt_allele, []) or csq_per_alt.get(_csq_allele(ref, alt_allele), [])
                        if matches and not jv.csq:  # don't overwrite if another member already set
                            jv.csq = matches
    return list(table.values())


def _parse_csq_format(header_line: str) -> list[str]:
    """Extract the pipe-delimited field list from a ##INFO=<ID=CSQ,...,Format=A|B|C> line."""
    # The Format=... segment ends with a closing quote or the trailing >.
    marker = "Format: "
    if marker not in header_line:
        marker = "Format="
    i = header_line.find(marker)
    if i < 0:
        return []
    rest = header_line[i + len(marker):]
    # Trim trailing quote/> noise.
    rest = rest.strip(' "').rstrip('">').strip()
    return [f.strip() for f in rest.split("|") if f.strip()]


def _parse_info(info: str) -> dict[str, str]:
    """Parse the VCF INFO column into a dict. Flag keys map to ''."""
    out: dict[str, str] = {}
    if not info or info == ".":
        return out
    for tok in info.split(";"):
        if "=" in tok:
            k, _, v = tok.partition("=")
            out[k] = v
        else:
            out[tok] = ""
    return out


def _parse_csq(raw: str, fields: list[str]) -> dict[str, list[dict[str, str]]]:
    """Split a CSQ INFO value into per-alt-allele lists of field dicts.

    Returns {allele_key: [{field: value, ...}, ...]} keyed by the CSQ
    'Allele' field. Caller maps allele_key back onto the VCF ALT.
    """
    out: dict[str, list[dict[str, str]]] = {}
    if not raw:
        return out
    try:
        allele_idx = fields.index("Allele")
    except ValueError:
        allele_idx = 0
    for entry in raw.split(","):
        vals = entry.split("|")
        if len(vals) < len(fields):
            vals = vals + [""] * (len(fields) - len(vals))
        rec = {fields[i]: vals[i] for i in range(len(fields))}
        allele = vals[allele_idx]
        out.setdefault(allele, []).append(rec)
    return out


def _csq_allele(ref: str, alt: str) -> str:
    """VEP's allele encoding for indels: insertions report the inserted bases
    only, deletions report '-'. Most VEP outputs use the raw alt; this is a
    best-effort fallback for the trimmed-allele convention."""
    if len(ref) == 1 and len(alt) > 1 and alt.startswith(ref):
        return alt[1:]  # insertion
    if len(alt) == 1 and len(ref) > 1 and ref.startswith(alt):
        return "-"      # deletion
    return alt


def _alt_count_for(gt: str, target_alt_idx: int) -> Optional[int]:
    """Count occurrences of `target_alt_idx` in a (possibly multi-allelic) GT string."""
    if not gt or gt.startswith("."):
        return None
    parts = gt.replace("|", "/").split("/")
    try:
        return sum(1 for p in parts if p != "." and int(p) == target_alt_idx)
    except ValueError:
        return None


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
