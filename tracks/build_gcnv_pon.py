"""Standalone gCNV panel-of-normals builder.

Uses only stdlib argparse (no Typer/Rich) so it runs inside the lean engine
container image — which ships GATK + samtools + the engine package but not the
dev CLI deps. Wraps variantgpt_engine.sv_calling.build_gcnv_pon.

Run over normal-sample BAMs of the SAME assay/capture as your cases (GATK
recommends ~30; ≥20 is a workable floor). Emits:
  <out-dir>/gcnv_pon.tgz          → upload to R2 key GCNV_MODEL_TGZ_KEY
  <out-dir>/filtered.interval_list → upload to R2 key GCNV_INTERVALS_KEY

Exome/panel:  --targets capture.bed --bin-length 0 --padding 250
WGS:          --targets primary_contigs.interval_list --bin-length 1000
              (restrict to chr1-22,X,Y so decoy/alt contigs don't mismatch the
               contig-ploidy-priors table)

Example (inside the engine image):
  python /app/tracks/build_gcnv_pon.py \
    --reference /data/Homo_sapiens_assembly38.fasta \
    --normal-bam /data/n1.bam --normal-bam /data/n2.bam ... \
    --contig-ploidy-priors /data/contig_ploidy_priors_GRCh38.tsv \
    --targets /data/capture.bed --bin-length 0 --padding 250 \
    --out-dir /data/gcnv_pon
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make the engine importable when run from a source checkout (the container
# image installs it, so this is a no-op there).
_THIS = Path(__file__).resolve()
_SRC = _THIS.parents[1] / "engine" / "src"
if _SRC.exists():
    sys.path.insert(0, str(_SRC))

from variantgpt_engine.sv_calling import build_gcnv_pon  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a gCNV panel-of-normals bundle.")
    ap.add_argument("--reference", required=True, type=Path, help="Reference FASTA (with .fai + .dict).")
    ap.add_argument("--normal-bam", required=True, action="append", dest="normal_bams", type=Path,
                    help="Normal-sample BAM; repeat the flag per sample.")
    ap.add_argument("--contig-ploidy-priors", required=True, type=Path,
                    help="Contig-ploidy priors TSV (see infra/gcnv/contig_ploidy_priors_GRCh38.tsv).")
    ap.add_argument("--out-dir", type=Path, default=Path("gcnv_pon"))
    ap.add_argument("--targets", type=Path, default=None,
                    help="Exome/panel BED or WGS primary-contigs interval_list.")
    ap.add_argument("--bin-length", type=int, default=1000, help="WGS bin length; 0 for exome/panel.")
    ap.add_argument("--padding", type=int, default=0, help="Interval padding; ~250 for exome/panel.")
    args = ap.parse_args()

    bundle, filtered = build_gcnv_pon(
        args.reference, args.normal_bams, args.contig_ploidy_priors, args.out_dir,
        bin_length=args.bin_length, padding=args.padding, targets=args.targets,
    )
    print(f"PON built:\n  bundle    = {bundle}\n  intervals = {filtered}")


if __name__ == "__main__":
    main()
