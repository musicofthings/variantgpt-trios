"""GRCh37 → GRCh38 liftover (PRD §4.2).

Wraps CrossMap. Variants that fail to lift are returned in a separate list,
never silently dropped — they surface in the case.json `lift_failed` bucket
and the UI's "lift-failed" view.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def lift_vcf(in_vcf: Path, chain: Path, out_vcf: Path) -> Path:
    """Liftover a VCF GRCh37 → GRCh38 using CrossMap. Returns the unmapped sidecar path.

    CrossMap writes {out_vcf}.unmap for variants that couldn't be lifted.
    """
    if not shutil.which("CrossMap.py") and not shutil.which("CrossMap"):
        raise RuntimeError("CrossMap not on PATH; `pip install CrossMap` and ensure CLI is exposed.")
    cmd = ["CrossMap.py", "vcf", str(chain), str(in_vcf), str(out_vcf)]
    subprocess.run(cmd, check=True)
    return Path(str(out_vcf) + ".unmap")
