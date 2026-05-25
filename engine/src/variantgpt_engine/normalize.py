"""Normalization wrapper around bcftools (PRD §4.2).

We shell out to `bcftools norm -m- -f <ref>` to (a) split multiallelics,
(b) left-align, (c) trim. Chromosome naming is normalized to a `chr` prefix.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def normalize(in_vcf: Path, reference: Path, out_vcf: Path) -> Path:
    if not shutil.which("bcftools"):
        raise RuntimeError("bcftools not on PATH (required for normalization).")
    cmd = [
        "bcftools", "norm",
        "-m-",                 # split multiallelics
        "-f", str(reference),  # left-align + trim against reference
        "-O", "z",
        "-o", str(out_vcf),
        str(in_vcf),
    ]
    subprocess.run(cmd, check=True)
    subprocess.run(["bcftools", "index", "-t", str(out_vcf)], check=True)
    return out_vcf


def ensure_chr_prefix(chrom: str) -> str:
    return chrom if chrom.startswith("chr") else f"chr{chrom}"
