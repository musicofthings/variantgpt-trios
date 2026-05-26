#!/usr/bin/env python3
"""Build a compact IndiGenomes allele-frequency database from the public VCF.

Source: https://clingen.igib.res.in/indigen/download/IndiGenomes_Variants.vcf.gz
  Cohort: 1,029 unrelated Indian whole genomes (IGIB IndiGen project).
  Size: ~137 MB compressed, ~55M variants.

Output: a SQLite DB indexed by (chrom, pos, ref, alt) with the columns the
engine needs:
    chrom TEXT, pos INTEGER, ref TEXT, alt TEXT,
    ac INTEGER, an INTEGER, af REAL, n_hom INTEGER

The DB is portable (single file), works on any platform, and gives
sub-millisecond lookups via an index.

Usage
-----
Download + build:
    python tracks/build_indigen_freqs.py --output indigen.sqlite

Use an already-downloaded VCF:
    python tracks/build_indigen_freqs.py \\
        --vcf path/to/IndiGenomes_Variants.vcf.gz \\
        --output indigen.sqlite

Upload to R2 (after build):
    wrangler r2 object put variantgpt/tracks/indigenomes/v1/indigen.sqlite \\
        --file=indigen.sqlite

The engine reads from that R2 key at startup.
"""
from __future__ import annotations

import argparse
import gzip
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path
from typing import Iterator, Optional

INDIGEN_VCF_URL = (
    "https://clingen.igib.res.in/indigen/download/IndiGenomes_Variants.vcf.gz"
)


def download_vcf(dest: Path) -> None:
    """Stream the IndiGen VCF to disk. ~137 MB so this takes a minute."""
    print(f"downloading {INDIGEN_VCF_URL} -> {dest}", file=sys.stderr)
    req = urllib.request.Request(
        INDIGEN_VCF_URL,
        headers={"User-Agent": "variantgpt-engine/0.1 indigen-builder"},
    )
    t = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        total = int(resp.headers.get("content-length", "0"))
        written = 0
        with open(dest, "wb") as out:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                out.write(chunk)
                written += len(chunk)
                if total:
                    pct = written * 100 // total
                    print(f"\r  {written:>12d}/{total} bytes ({pct}%)",
                          end="", file=sys.stderr)
    print(f"\n  done in {int(time.time() - t)}s", file=sys.stderr)


def stream_records(vcf_path: Path) -> Iterator[tuple]:
    """Yield (chrom, pos, ref, alt, ac, an, af, n_hom) tuples from a VCF."""
    opener = gzip.open if str(vcf_path).endswith(".gz") else open
    with opener(vcf_path, "rt", encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            cols = line.split("\t")
            if len(cols) < 8:
                continue
            chrom, pos_s, _id, ref, alt_raw, _qual, _filter, info = cols[:8]
            try:
                pos = int(pos_s)
            except ValueError:
                continue

            # IndiGen INFO fields. Confirmed in their VCF header:
            #   AC, AN, AF, n_hom — the standard 1000G-style allele counts.
            kv = _parse_info(info)

            # Split multi-allelic sites — emit one record per ALT.
            alts = alt_raw.split(",")
            af_list = _parse_list(kv.get("AF"), float, len(alts))
            ac_list = _parse_list(kv.get("AC"), int, len(alts))
            an = _parse_single(kv.get("AN"), int)
            nhom_list = _parse_list(kv.get("n_hom") or kv.get("nhomalt") or kv.get("AC_Hom"), int, len(alts))

            for i, alt in enumerate(alts):
                af = af_list[i] if af_list else None
                ac = ac_list[i] if ac_list else None
                # If AF not given but AC and AN are, compute it.
                if af is None and ac is not None and an:
                    af = ac / an
                if af is None:
                    continue
                nhom = nhom_list[i] if nhom_list else None
                yield (
                    _normalize_chrom(chrom),
                    pos,
                    ref,
                    alt,
                    ac,
                    an,
                    af,
                    nhom,
                )


def _normalize_chrom(chrom: str) -> str:
    bare = chrom.removeprefix("chr").removeprefix("Chr")
    if bare in ("M", "MT"):
        bare = "M"
    return f"chr{bare}"


def _parse_info(info: str) -> dict[str, str]:
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


def _parse_list(raw: Optional[str], cast, expected_len: int) -> Optional[list]:
    if not raw:
        return None
    parts = raw.split(",")
    out = []
    for p in parts:
        try:
            out.append(cast(p))
        except (ValueError, TypeError):
            out.append(None)
    while len(out) < expected_len:
        out.append(None)
    return out


def _parse_single(raw: Optional[str], cast):
    if not raw:
        return None
    try:
        return cast(raw)
    except (ValueError, TypeError):
        return None


def build_db(vcf_path: Path, db_path: Path) -> None:
    """Stream the VCF into a fresh SQLite DB. Drop the old one if exists."""
    if db_path.exists():
        db_path.unlink()
    print(f"building {db_path} from {vcf_path}", file=sys.stderr)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = OFF")        # speed; this is bulk import
    conn.execute("PRAGMA synchronous = OFF")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute(
        """
        CREATE TABLE freq (
            chrom TEXT NOT NULL,
            pos   INTEGER NOT NULL,
            ref   TEXT NOT NULL,
            alt   TEXT NOT NULL,
            ac    INTEGER,
            an    INTEGER,
            af    REAL NOT NULL,
            n_hom INTEGER
        )
        """
    )

    BATCH = 50_000
    t = time.time()
    batch: list = []
    total = 0
    with conn:
        for rec in stream_records(vcf_path):
            batch.append(rec)
            if len(batch) >= BATCH:
                conn.executemany(
                    "INSERT INTO freq (chrom,pos,ref,alt,ac,an,af,n_hom) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    batch,
                )
                total += len(batch)
                batch.clear()
                if total % 500_000 == 0:
                    print(f"  inserted {total:,} records",
                          file=sys.stderr, flush=True)
        if batch:
            conn.executemany(
                "INSERT INTO freq (chrom,pos,ref,alt,ac,an,af,n_hom) "
                "VALUES (?,?,?,?,?,?,?,?)",
                batch,
            )
            total += len(batch)

    print(f"  inserted {total:,} records in {int(time.time() - t)}s",
          file=sys.stderr)
    print("  building index on (chrom, pos, ref, alt)…",
          file=sys.stderr, flush=True)
    t = time.time()
    conn.execute(
        "CREATE INDEX idx_freq_key ON freq (chrom, pos, ref, alt)"
    )
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    print(f"  done in {int(time.time() - t)}s. "
          f"final file size: {db_path.stat().st_size / 1024 / 1024:.1f} MB",
          file=sys.stderr)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--vcf", type=Path, default=None,
                   help="path to a downloaded IndiGen VCF; if absent, downloads automatically")
    p.add_argument("--output", type=Path, required=True,
                   help="output SQLite path (e.g. indigen.sqlite)")
    p.add_argument("--keep-download", action="store_true",
                   help="keep the downloaded VCF file (default: delete after build)")
    args = p.parse_args()

    if args.vcf and args.vcf.exists():
        vcf_path = args.vcf
        downloaded_here = False
    else:
        vcf_path = args.output.with_suffix(".source.vcf.gz")
        if not vcf_path.exists():
            download_vcf(vcf_path)
        downloaded_here = True

    build_db(vcf_path, args.output)

    if downloaded_here and not args.keep_download:
        try:
            os.unlink(vcf_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
