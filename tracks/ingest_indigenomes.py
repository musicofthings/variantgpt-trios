"""IndiGenomes (~55M variants, GRCh38) → bgzip+tabix → R2.

Stub. Real implementation:
  1. Download the AF/AC/AN/het/hom dump from IndiGenomes for academic use.
  2. Normalize: ensure GRCh38, chr-prefix, REF/ALT trimmed/left-aligned.
  3. Emit TSV: chrom, pos, ref, alt, ac, an, af, n_hom, n_het.
  4. `bgzip` + `tabix -s1 -b2 -e2`.
  5. Upload to R2 under tracks/indigenomes-v{version}/.
"""
from __future__ import annotations

if __name__ == "__main__":
    raise SystemExit("Not implemented — see PRD §4.6 and tracks/README.md.")
