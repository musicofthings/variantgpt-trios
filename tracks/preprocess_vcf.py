#!/usr/bin/env python3
"""CLI wrapper around variantgpt_engine.preprocess.

Usage examples
--------------
Clean a single VCF with defaults (GQ≥20, DP≥10, QUAL≥30, AB 0.20-0.80):
    python tracks/preprocess_vcf.py --in patient.vcf --out patient.clean.vcf

Less strict QC (e.g. low-coverage exome):
    python tracks/preprocess_vcf.py --in patient.vcf --out clean.vcf \
        --gq-min 10 --dp-min 5

Keep original chrom format (don't add 'chr' prefix):
    python tracks/preprocess_vcf.py --in patient.vcf --out clean.vcf --chrom keep

Process the whole demo trio in one go:
    for who in proband father mother; do
      python tracks/preprocess_vcf.py \
        --in  data/test/demo_trio/$who.vcf \
        --out data/test/demo_trio/$who.clean.vcf
    done

The library lives at engine/src/variantgpt_engine/preprocess.py. The same
function `preprocess_vcf()` is called by the engine container during a trio
run, so what you get from this CLI matches exactly what the engine does
to your uploads.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running from the repo root without installing the engine.
THIS = Path(__file__).resolve()
sys.path.insert(0, str(THIS.parents[1] / "engine" / "src"))

from variantgpt_engine.preprocess import _main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(_main())
