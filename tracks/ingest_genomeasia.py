"""GenomeAsia 100K → R2 ingestion CLI.

Downloads the 23 composite VCF files (chr 1–22 substitutions + All indels)
from browser.genomeasia100k.org, validates against the upstream MD5
manifest, extracts a compact AF lookup table per variant, and uploads to
R2 in a layout the engine adapter (`genomeasia.py`) understands.

Why this is a CLI tool rather than a container_server stage:
  - browser.genomeasia100k.org currently blocks cloud egress IPs (Fly,
    Cloudflare Workers, AWS, GCP all observed). The download has to run
    from a residential / institutional / VPN'd network. Once the data
    lands in R2, the engine reads from R2 normally.
  - The composite files are several GB total. One-shot ingestion is the
    right shape.

Usage:
    # 1. Download the 23 .vcf.gz files locally (from a network that can
    #    reach the host — your laptop, a VPN'd workstation, an institutional
    #    mirror, etc.). Reference shell loop at the bottom of this docstring.
    # 2. Run ingestion:
    python tracks/ingest_genomeasia.py \
        --src ./GenomeAsia100K \
        --bucket variantgpt \
        --r2-prefix tracks/genomeasia/v1 \
        --skip-validate                # optional; default validates MD5

    # 3. Set the engine env var so the adapter activates:
    #    GENOMEASIA_R2_PREFIX=tracks/genomeasia/v1
    # The Worker mints signed GET URLs for the engine to range-read the
    # AF map.

Reference download script (run from your local terminal — NOT this engine):

    mkdir -p GenomeAsia100K && cd GenomeAsia100K
    BASE=https://browser.genomeasia100k.org/service/web/download_files
    for i in {1..22}; do
      wget -c --no-check-certificate "$BASE/${i}.substitutions.annot.cont_withmaf.vcf.gz"
    done
    wget -c --no-check-certificate "$BASE/All.indels.annot.cont_withmaf.vcf.gz"
    wget -c --no-check-certificate "$BASE/md5sum.info.txt"

Outputs in R2 (under --r2-prefix):
    af/chr1.tsv.gz           ← tab-separated (chrom, pos, ref, alt, af, ac, an)
    af/chr2.tsv.gz
    …
    af/chr22.tsv.gz
    af/indels.tsv.gz
    manifest.json            ← { version, generated_at, files: {chr1: {size, sha256, n_variants}, …} }

The TSV layout is intentional: small, range-readable by chrom prefix in
R2, scannable by gene without an index. We don't bother with tabix
because gene-level queries are bounded by known exon ranges; a
streaming gzip scan of chr1.tsv.gz is ~1s and CF Workers can fetch
ranges natively.

Field selection from the upstream VCF (in priority order):
    INFO/AF        — alt allele frequency (preferred when present)
    INFO/MAF       — minor allele frequency (fallback)
    INFO/AC, INFO/AN — count + total when AF/MAF absent
First-present wins. Multi-allelic sites are split per (ref, alt) at
parse time so each row carries a single alt.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("ingest_genomeasia")

CHROM_FILES = [f"{i}.substitutions.annot.cont_withmaf.vcf.gz" for i in range(1, 23)]
INDEL_FILE = "All.indels.annot.cont_withmaf.vcf.gz"
MD5_FILE = "md5sum.info.txt"

INFO_AF_RE = re.compile(r"(?:^|;)(?:AF|MAF)=([^;]+)")
INFO_AC_RE = re.compile(r"(?:^|;)AC=([^;]+)")
INFO_AN_RE = re.compile(r"(?:^|;)AN=([^;]+)")


@dataclass
class ChromStats:
    chrom: str
    rows_in: int
    rows_out: int
    sha256: str
    size_bytes: int


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--src", required=True, type=Path, help="Local directory containing the downloaded .vcf.gz files")
    p.add_argument("--out", type=Path, default=Path("./out-genomeasia"), help="Local output directory before R2 upload")
    p.add_argument("--bucket", default="variantgpt", help="R2 bucket name")
    p.add_argument("--r2-prefix", default="tracks/genomeasia/v1", help="Key prefix under the bucket")
    p.add_argument("--skip-validate", action="store_true", help="Skip MD5 validation")
    p.add_argument("--skip-upload", action="store_true", help="Build TSVs locally but don't upload to R2")
    p.add_argument("--wrangler", default="wrangler", help="Path to wrangler CLI")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if not args.src.is_dir():
        log.error("source directory does not exist: %s", args.src)
        return 2

    if not args.skip_validate:
        if not validate_md5(args.src):
            log.error("MD5 validation failed; use --skip-validate to override")
            return 3

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "af").mkdir(exist_ok=True)

    stats: list[ChromStats] = []
    for vcf_name in CHROM_FILES:
        chrom_num = vcf_name.split(".")[0]
        src = args.src / vcf_name
        if not src.exists():
            log.warning("missing %s; skipping", vcf_name)
            continue
        out_path = args.out / "af" / f"chr{chrom_num}.tsv.gz"
        log.info("converting %s → %s", vcf_name, out_path.name)
        s = convert_vcf_to_af_tsv(src, out_path, chrom=f"chr{chrom_num}")
        stats.append(s)
        log.info("  chr%s: %d → %d rows (%s, %.1f MB)", chrom_num, s.rows_in, s.rows_out, s.sha256[:12], s.size_bytes / 1e6)

    indel_src = args.src / INDEL_FILE
    if indel_src.exists():
        out_path = args.out / "af" / "indels.tsv.gz"
        log.info("converting %s → %s", INDEL_FILE, out_path.name)
        s = convert_vcf_to_af_tsv(indel_src, out_path, chrom=None)
        stats.append(s)
        log.info("  indels: %d → %d rows (%s, %.1f MB)", s.rows_in, s.rows_out, s.sha256[:12], s.size_bytes / 1e6)
    else:
        log.warning("indel file not found: %s", INDEL_FILE)

    manifest = {
        "version": "v1",
        "source": "GenomeAsia 100K composite VCFs from browser.genomeasia100k.org",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "files": {
            s.chrom: {
                "size_bytes": s.size_bytes,
                "sha256": s.sha256,
                "rows_in": s.rows_in,
                "rows_out": s.rows_out,
            }
            for s in stats
        },
        "total_variants": sum(s.rows_out for s in stats),
    }
    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))
    log.info("manifest: %s", manifest_path)
    log.info("total variants: %d", manifest["total_variants"])

    if args.skip_upload:
        log.info("--skip-upload set; local outputs ready at %s", args.out)
        return 0

    log.info("uploading to r2://%s/%s/", args.bucket, args.r2_prefix)
    files_to_upload = list((args.out / "af").glob("*.tsv.gz")) + [manifest_path]
    for f in files_to_upload:
        rel = f.relative_to(args.out)
        key = f"{args.r2_prefix}/{rel.as_posix()}"
        log.info("  PUT %s ← %s (%.1f MB)", key, rel, f.stat().st_size / 1e6)
        rc = os.system(
            f'{args.wrangler} r2 object put "{args.bucket}/{key}" --file "{f}" --remote',
        )
        if rc != 0:
            log.error("wrangler upload failed for %s; aborting", key)
            return 4

    log.info("done. Set engine env var GENOMEASIA_R2_PREFIX=%s to activate the adapter.", args.r2_prefix)
    return 0


def validate_md5(src: Path) -> bool:
    """Validate every .vcf.gz in src against md5sum.info.txt. Lines in that
    file are `<md5>  <filename>`."""
    md5_path = src / MD5_FILE
    if not md5_path.exists():
        log.warning("md5sum.info.txt not present in %s; cannot validate", src)
        return False
    expected: dict[str, str] = {}
    for line in md5_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        expected[parts[1].lstrip("./")] = parts[0]
    ok = True
    for name, want in expected.items():
        p = src / name
        if not p.exists():
            continue
        got = sha_or_md5(p, hashlib.md5)
        if got != want:
            log.error("md5 mismatch for %s: want %s got %s", name, want, got)
            ok = False
        else:
            log.debug("md5 ok: %s", name)
    return ok


def sha_or_md5(path: Path, ctor) -> str:
    h = ctor()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def convert_vcf_to_af_tsv(src: Path, out_path: Path, chrom: Optional[str]) -> ChromStats:
    """Stream-read a bgzipped VCF, emit `chrom\\tpos\\tref\\talt\\taf\\tac\\tan` rows.
    Multi-allelic sites are split — one row per (ref, alt). For chrom-specific
    files pass `chrom="chr1"` etc; for the indel file (rows span chromosomes)
    pass None and we use the VCF's own CHROM column."""
    rows_in = 0
    rows_out = 0
    with gzip.open(out_path, "wb") as out_gz:
        out_gz.write(b"#chrom\tpos\tref\talt\taf\tac\tan\n")
        with gzip.open(src, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("#") or not line.strip():
                    continue
                rows_in += 1
                cols = line.rstrip("\n").split("\t")
                if len(cols) < 8:
                    continue
                row_chrom = chrom if chrom else _normalize_chrom(cols[0])
                pos = cols[1]
                ref = cols[3]
                alts = cols[4].split(",")
                info = cols[7]
                ac_list = _info_list(info, INFO_AC_RE)
                an = _info_scalar(info, INFO_AN_RE)
                af_list = _info_list(info, INFO_AF_RE)
                for i, alt in enumerate(alts):
                    if alt in ("", ".", "*"):
                        continue
                    af = af_list[i] if i < len(af_list) else None
                    ac = ac_list[i] if i < len(ac_list) else None
                    if af is None and ac is not None and an:
                        try:
                            af = str(float(ac) / float(an))
                        except (ValueError, ZeroDivisionError):
                            af = None
                    if af is None:
                        continue
                    out_gz.write(
                        f"{row_chrom}\t{pos}\t{ref}\t{alt}\t{af}\t{ac or ''}\t{an or ''}\n".encode("ascii"),
                    )
                    rows_out += 1
    size = out_path.stat().st_size
    sha = sha_or_md5(out_path, hashlib.sha256)
    return ChromStats(
        chrom=out_path.stem.split(".")[0],
        rows_in=rows_in,
        rows_out=rows_out,
        sha256=sha,
        size_bytes=size,
    )


def _info_scalar(info: str, regex: re.Pattern) -> Optional[str]:
    m = regex.search(info)
    return m.group(1) if m else None


def _info_list(info: str, regex: re.Pattern) -> list[Optional[str]]:
    m = regex.search(info)
    if not m:
        return []
    return [v if v not in ("", ".") else None for v in m.group(1).split(",")]


def _normalize_chrom(c: str) -> str:
    c = c.strip()
    return c if c.startswith("chr") else f"chr{c}"


if __name__ == "__main__":
    sys.exit(main())
