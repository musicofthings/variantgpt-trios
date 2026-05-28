"""VCF preprocessing for the trio engine.

Industry-standard cleanup steps performed (single pass over input):

  1. Header validation       — confirms ##fileformat, accepts contigs
                                 missing (we tolerate minimal headers).
  2. Chromosome standardization
                              — normalize "1"/"chr1"/"Chr1" to one canonical
                                 form per output (default: "chr"-prefixed,
                                 GATK/Ensembl GRCh38 convention).
  3. Multi-allelic split     — split A,T,G alt lists into one record per alt.
                                 Genotype indices are rewritten per-alt (e.g.
                                 "0/2" becomes "0/1" on the alt-2 record).
                                 (Equivalent to `bcftools norm -m -any`.)
  4. Allele trimming         — trim shared prefix + suffix bases between REF
                                 and ALT (e.g. ATG/ATC → G/C).
                                 (Equivalent to `bcftools norm` left/right trim.)
  5. Site-level QC           — drop sites where FILTER ∉ {PASS, ., empty}.
                                 Optional QUAL floor (default: keep ≥30).
  6. Genotype-level QC       — replace low-quality genotype calls with ./.
                                 Defaults match GATK Best Practices for clinical:
                                   GQ < 20            → ./.
                                   DP < 10            → ./.
                                   AB(het) outside 0.20-0.80 → ./.
  7. Hom-ref pruning         — drop sites where every remaining genotype is
                                 0/0 or ./. (no information for variant calling).
  8. De-duplication          — collapse exact-duplicate (chrom, pos, ref, alt) records,
                                 keeping the first occurrence.
  9. Sort                    — output sorted by chrom (natural order: 1..22, X, Y, M)
                                 then position. The trio merge step assumes sorted input.

What we deliberately DON'T do here:
  - Left-align indels across repeat tracts (needs the reference genome FASTA;
    `bcftools norm -f ref.fa` is the right tool for that, and it can be added
    later as an optional step when ref FASTA is available locally).
  - Build liftover (GRCh37 → GRCh38). Use CrossMap or LiftoverVcf separately.
  - VEP/SnpEff annotation. Done by the engine annotation stage downstream.

The module exposes both a library entry point (`preprocess_vcf`) and a CLI
(`python -m variantgpt_engine.preprocess --in ... --out ...`). The engine
calls `preprocess_vcf` per uploaded VCF before joint-matrix construction.
"""
from __future__ import annotations

import gzip
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import IO, Optional


@dataclass
class PreprocessConfig:
    """All tunable preprocessor settings. The defaults are clinical-grade
    starting points; pass overrides if your input pipeline already applies
    some of these."""
    qual_min: float = 30.0
    gq_min: int = 20
    dp_min: int = 10
    het_ab_min: float = 0.20
    het_ab_max: float = 0.80
    drop_filtered: bool = True
    drop_hom_ref: bool = True
    normalize_chrom: str = "chr"  # "chr" (default), "" (strip prefix), or "keep"
    sort_output: bool = True


@dataclass
class CleanupReport:
    input_records: int = 0
    output_records: int = 0
    multi_allelic_split: int = 0
    dropped_filtered: int = 0
    dropped_low_qual: int = 0
    dropped_hom_ref: int = 0
    dropped_duplicate: int = 0
    trimmed_alleles: int = 0
    gt_filtered_low_gq: int = 0
    gt_filtered_low_dp: int = 0
    gt_filtered_bad_ab: int = 0
    elapsed_ms: int = 0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ────────────────────────── public entry points ──────────────────────────


def preprocess_vcf(
    input_path: Path, output_path: Path,
    *, config: Optional[PreprocessConfig] = None,
) -> CleanupReport:
    """Clean an input VCF to `output_path`. Both paths support .vcf and .vcf.gz.
    Returns a CleanupReport with per-step counts."""
    config = config or PreprocessConfig()
    report = CleanupReport()
    start = time.monotonic()

    with _open_read(input_path) as fh:
        header_lines, sample_ids = _read_header(fh, report)
        cleaned = _process_records(fh, sample_ids, config, report)
        if config.sort_output:
            cleaned = _sort_records(cleaned)

    header_lines = _ensure_filter_header(header_lines)
    with _open_write(output_path) as out:
        for h in header_lines:
            out.write(h + "\n")
        for rec in cleaned:
            out.write(rec + "\n")
            report.output_records += 1

    report.elapsed_ms = int((time.monotonic() - start) * 1000)
    return report


# ────────────────────────── header handling ──────────────────────────


def _read_header(fh: IO[str], report: CleanupReport) -> tuple[list[str], list[str]]:
    """Return (header_lines, sample_ids). Consumes through the #CHROM line."""
    header: list[str] = []
    sample_ids: list[str] = []
    saw_fileformat = False
    for raw in fh:
        line = raw.rstrip("\n")
        if not line:
            continue
        if line.startswith("##"):
            if line.startswith("##fileformat"):
                saw_fileformat = True
            header.append(line)
            continue
        if line.startswith("#CHROM"):
            header.append(line)
            cols = line.split("\t")
            if len(cols) > 9:
                sample_ids = cols[9:]
            break
    if not saw_fileformat:
        report.warnings.append("missing ##fileformat header; inserting fileformat=VCFv4.2")
        header.insert(0, "##fileformat=VCFv4.2")
    if not sample_ids:
        report.warnings.append("no sample columns found — output will be sites-only")
    return header, sample_ids


def _ensure_filter_header(header: list[str]) -> list[str]:
    """Ensure FILTER=PASS line exists so downstream tools accept output."""
    if any('##FILTER=<ID=PASS' in h for h in header):
        return header
    # Insert after fileformat for cleanliness.
    out = []
    inserted = False
    for h in header:
        out.append(h)
        if not inserted and h.startswith("##fileformat"):
            out.append('##FILTER=<ID=PASS,Description="All filters passed">')
            inserted = True
    if not inserted:
        out.insert(0, '##FILTER=<ID=PASS,Description="All filters passed">')
    return out


# ────────────────────────── record-level processing ──────────────────────────


def _process_records(
    fh: IO[str], sample_ids: list[str], config: PreprocessConfig, report: CleanupReport,
) -> list[str]:
    """Stream the body, apply all per-record transformations, collect output."""
    seen_keys: set[tuple[str, int, str, str]] = set()
    out: list[str] = []
    for raw in fh:
        line = raw.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        report.input_records += 1
        cols = line.split("\t")
        if len(cols) < 8:
            report.warnings.append(f"truncated record (cols={len(cols)}); dropped")
            continue

        chrom = _normalize_chrom(cols[0], config.normalize_chrom)
        try:
            pos = int(cols[1])
        except ValueError:
            report.warnings.append(f"non-integer POS '{cols[1]}'; dropped")
            continue
        vid, ref, alt_raw, qual, filt, info = cols[2], cols[3], cols[4], cols[5], cols[6], cols[7]
        fmt = cols[8] if len(cols) > 8 else ""
        sample_vals = cols[9:] if len(cols) > 9 else []

        # Site-level filters first (cheapest).
        if config.drop_filtered and filt not in ("", ".", "PASS"):
            report.dropped_filtered += 1
            continue
        try:
            qual_val = float(qual) if qual not in ("", ".") else None
        except ValueError:
            qual_val = None
        if qual_val is not None and qual_val < config.qual_min:
            report.dropped_low_qual += 1
            continue

        # Split multi-allelic.
        alts = alt_raw.split(",") if alt_raw else []
        if len(alts) > 1:
            report.multi_allelic_split += (len(alts) - 1)
        for alt_idx, alt in enumerate(alts, start=1):
            if not alt or alt == ".":
                continue

            # Trim shared prefix/suffix bases.
            trimmed_ref, trimmed_alt, trimmed_pos = _trim_alleles(ref, alt, pos)
            if (trimmed_ref, trimmed_alt) != (ref, alt):
                report.trimmed_alleles += 1

            # Apply per-genotype QC; reduce multi-allelic GT to per-alt GT first.
            new_samples = _per_genotype_qc(
                sample_vals, fmt, alt_idx, num_alts=len(alts), config=config, report=report,
            )

            if config.drop_hom_ref and new_samples and _all_hom_ref_or_missing(new_samples, fmt):
                report.dropped_hom_ref += 1
                continue

            key = (chrom, trimmed_pos, trimmed_ref, trimmed_alt)
            if key in seen_keys:
                report.dropped_duplicate += 1
                continue
            seen_keys.add(key)

            new_cols = [
                chrom, str(trimmed_pos), vid, trimmed_ref, trimmed_alt,
                qual, "PASS", info,
            ]
            if fmt:
                new_cols.append(fmt)
                new_cols.extend(new_samples)
            out.append("\t".join(new_cols))
    return out


# ────────────────────────── chrom + allele normalization ──────────────────────────


def _normalize_chrom(chrom: str, mode: str) -> str:
    if mode == "keep":
        return chrom
    bare = chrom.removeprefix("chr").removeprefix("Chr").removeprefix("CHR")
    # Coalesce mitochondrial naming.
    if bare in ("M", "MT"):
        bare = "M"
    if mode == "":
        return bare
    # mode == "chr": always emit the chr-prefixed form.
    return f"chr{bare}"


def _trim_alleles(ref: str, alt: str, pos: int) -> tuple[str, str, int]:
    """Trim shared prefix/suffix bases (right-then-left). Returns (ref, alt, pos).
    Keeps at least 1 base in each. This matches the canonical VCF normalization."""
    # Right-trim shared suffix.
    while len(ref) > 1 and len(alt) > 1 and ref[-1] == alt[-1]:
        ref, alt = ref[:-1], alt[:-1]
    # Left-trim shared prefix; advance position correspondingly.
    while len(ref) > 1 and len(alt) > 1 and ref[0] == alt[0]:
        ref, alt = ref[1:], alt[1:]
        pos += 1
    return ref, alt, pos


# ────────────────────────── genotype-level QC ──────────────────────────


def _per_genotype_qc(
    sample_vals: list[str], fmt: str, target_alt_idx: int, num_alts: int,
    *, config: PreprocessConfig, report: CleanupReport,
) -> list[str]:
    """For each sample column: rewrite GT for this alt index and replace the
    whole call with ./. if QC thresholds fail."""
    if not fmt or not sample_vals:
        return sample_vals
    fmt_keys = fmt.split(":")
    try:
        gt_idx = fmt_keys.index("GT")
    except ValueError:
        return sample_vals
    dp_idx = fmt_keys.index("DP") if "DP" in fmt_keys else None
    gq_idx = fmt_keys.index("GQ") if "GQ" in fmt_keys else None
    ad_idx = fmt_keys.index("AD") if "AD" in fmt_keys else None

    out: list[str] = []
    for raw in sample_vals:
        vals = raw.split(":")
        if len(vals) <= gt_idx:
            out.append(raw)
            continue

        gt_str = vals[gt_idx]
        new_gt = _reduce_gt_for_alt(gt_str, target_alt_idx, num_alts)

        if new_gt != "./.":  # only apply QC if call isn't already missing
            failed = False
            if gq_idx is not None and gq_idx < len(vals):
                gq_v = _try_int(vals[gq_idx])
                if gq_v is not None and gq_v < config.gq_min:
                    failed = True
                    report.gt_filtered_low_gq += 1
            if not failed and dp_idx is not None and dp_idx < len(vals):
                dp_v = _try_int(vals[dp_idx])
                if dp_v is not None and dp_v < config.dp_min:
                    failed = True
                    report.gt_filtered_low_dp += 1
            if not failed and _gt_is_het(new_gt) and ad_idx is not None and ad_idx < len(vals):
                ab = _ab_from_ad(vals[ad_idx], target_alt_idx)
                if ab is not None and (ab < config.het_ab_min or ab > config.het_ab_max):
                    failed = True
                    report.gt_filtered_bad_ab += 1
            if failed:
                new_gt = "./."
                # Null out the other fields too, since they refer to a now-suspect call.
                vals = [new_gt] + ["." for _ in vals[1:]]
                out.append(":".join(vals))
                continue

        vals[gt_idx] = new_gt
        out.append(":".join(vals))
    return out


def _reduce_gt_for_alt(gt: str, target_alt_idx: int, num_alts: int) -> str:
    """Map a multi-allelic GT (e.g. '0/2' with target_alt=2) into the per-alt GT
    on the split record. The new GT uses 1 for the target alt and 0 for ref/other-alt."""
    if not gt or gt.startswith("."):
        return "./." if "/" in gt or "|" in gt else "."
    sep = "/" if "/" in gt else ("|" if "|" in gt else None)
    if sep is None:
        # Hemizygous — single allele.
        return "1" if gt == str(target_alt_idx) else ("0" if gt == "0" else "./.")
    parts = gt.split(sep)
    new_parts: list[str] = []
    for p in parts:
        if p == ".":
            new_parts.append(".")
        elif p == "0":
            new_parts.append("0")
        elif p == str(target_alt_idx):
            new_parts.append("1")
        else:
            # A different alt index — for the per-alt record this allele is
            # "not the target alt", so encode as 0 (reference for this site).
            # That's how `bcftools norm -m -any` handles it.
            new_parts.append("0")
    return sep.join(new_parts)


def _gt_is_het(gt: str) -> bool:
    sep = "/" if "/" in gt else ("|" if "|" in gt else None)
    if sep is None:
        return False
    parts = gt.split(sep)
    nums = {p for p in parts if p != "."}
    return "0" in nums and "1" in nums


def _ab_from_ad(ad_str: str, target_alt_idx: int) -> Optional[float]:
    if not ad_str or ad_str == ".":
        return None
    try:
        ad = [int(x) for x in ad_str.split(",") if x not in ("", ".")]
    except ValueError:
        return None
    if target_alt_idx >= len(ad):
        return None
    total = sum(ad)
    return ad[target_alt_idx] / total if total else None


def _try_int(s: str) -> Optional[int]:
    try:
        return int(s) if s and s != "." else None
    except ValueError:
        return None


def _all_hom_ref_or_missing(samples: list[str], fmt: str) -> bool:
    if not fmt:
        return False
    fmt_keys = fmt.split(":")
    try:
        gt_idx = fmt_keys.index("GT")
    except ValueError:
        return False
    for s in samples:
        vals = s.split(":")
        if gt_idx >= len(vals):
            return False
        gt = vals[gt_idx]
        if gt and gt not in ("./.", ".|.", ".", "0/0", "0|0", "0"):
            return False
    return True


# ────────────────────────── sort ──────────────────────────


def _sort_records(records: list[str]) -> list[str]:
    """Natural-order chrom sort (1..22, X, Y, M) then position."""
    def keyfn(line: str) -> tuple:
        c, p = line.split("\t", 2)[:2]
        return (_chrom_rank(c), int(p))
    return sorted(records, key=keyfn)


def _chrom_rank(chrom: str) -> tuple[int, str]:
    bare = chrom.removeprefix("chr")
    if bare.isdigit():
        return (int(bare), "")
    if bare == "X":
        return (23, "")
    if bare == "Y":
        return (24, "")
    if bare in ("M", "MT"):
        return (25, "")
    return (99, bare)  # contigs (alts, decoys) at the end


# ────────────────────────── I/O helpers ──────────────────────────


def _open_read(path: Path):
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "rt", encoding="utf-8")


def _open_write(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if str(path).endswith(".gz"):
        return gzip.open(path, "wt", encoding="utf-8")
    return open(path, "wt", encoding="utf-8")


# ────────────────────────── CLI ──────────────────────────


def _main() -> int:
    import argparse
    import json as _json
    p = argparse.ArgumentParser(
        description="Clean and normalize a VCF for the VariantGPT trio engine.",
    )
    p.add_argument("--in", dest="inp", required=True, help="input VCF (.vcf or .vcf.gz)")
    p.add_argument("--out", dest="outp", required=True, help="output VCF (.vcf or .vcf.gz)")
    p.add_argument("--gq-min", type=int, default=20)
    p.add_argument("--dp-min", type=int, default=10)
    p.add_argument("--qual-min", type=float, default=30.0)
    p.add_argument("--het-ab-min", type=float, default=0.20)
    p.add_argument("--het-ab-max", type=float, default=0.80)
    p.add_argument("--no-drop-filtered", action="store_false", dest="drop_filtered")
    p.add_argument("--no-drop-hom-ref", action="store_false", dest="drop_hom_ref")
    p.add_argument("--no-sort", action="store_false", dest="sort_output")
    p.add_argument(
        "--chrom",
        choices=("chr", "", "keep"),
        default="chr",
        help='Output chrom format: "chr" (default, GATK/Ensembl GRCh38), "" (strip), "keep"',
    )
    p.add_argument("--report", default=None, help="optional path to write JSON cleanup report")
    args = p.parse_args()

    cfg = PreprocessConfig(
        qual_min=args.qual_min,
        gq_min=args.gq_min,
        dp_min=args.dp_min,
        het_ab_min=args.het_ab_min,
        het_ab_max=args.het_ab_max,
        drop_filtered=args.drop_filtered,
        drop_hom_ref=args.drop_hom_ref,
        normalize_chrom=args.chrom,
        sort_output=args.sort_output,
    )
    rep = preprocess_vcf(Path(args.inp), Path(args.outp), config=cfg)
    print(_json.dumps(rep.to_dict(), indent=2))
    if args.report:
        Path(args.report).write_text(_json.dumps(rep.to_dict(), indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
