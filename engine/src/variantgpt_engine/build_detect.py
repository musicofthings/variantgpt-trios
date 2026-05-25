"""Auto-detect reference build (PRD §4.2).

Strategy:
  1. Parse VCF header `##reference=` and `##contig=` lengths.
  2. Match chr1 length: 249250621 → GRCh37, 248956422 → GRCh38.
  3. If ambiguous, caller should fall back to coordinate spot-checks against
     build-specific markers (TODO) or prompt the user.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from .models import Build

_CHR1_LEN = {249250621: Build.grch37, 248956422: Build.grch38}


def detect_build(vcf_path: Path) -> Optional[Build]:
    try:
        import gzip
        opener = gzip.open if str(vcf_path).endswith(".gz") else open
        with opener(vcf_path, "rt") as fh:
            for line in fh:
                if not line.startswith("#"):
                    break
                if line.startswith("##reference"):
                    val = line.strip().split("=", 1)[1].lower()
                    if "grch37" in val or "hg19" in val or "b37" in val:
                        return Build.grch37
                    if "grch38" in val or "hg38" in val:
                        return Build.grch38
                if line.startswith("##contig=") and ("ID=1," in line or "ID=chr1," in line):
                    # ##contig=<ID=1,length=249250621>
                    try:
                        length = int(line.split("length=")[1].split(",")[0].rstrip(">"))
                        if length in _CHR1_LEN:
                            return _CHR1_LEN[length]
                    except (IndexError, ValueError):
                        pass
    except OSError:
        return None
    return None
