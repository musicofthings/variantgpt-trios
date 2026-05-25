"""Emit per-member VCFs + a PED file from the curated demo dataset.

Generates a deterministic trio (proband / father / mother) with deliberate
inheritance patterns so the engine's inheritance modeling, ACMG, and South
Asian reclassification each have visible firings in the demo.

Run:
    python tracks/build_demo_vcfs.py

Writes:
    data/test/demo_trio/proband.vcf
    data/test/demo_trio/father.vcf
    data/test/demo_trio/mother.vcf
    data/test/demo_trio/family.ped
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tracks"))

from demo_data import DEMO_VARIANTS, DemoVariant  # noqa: E402

OUT = ROOT / "data" / "test" / "demo_trio"
PROBAND_ID = "PROBAND_001"
FATHER_ID = "FATHER_001"
MOTHER_ID = "MOTHER_001"
FAMILY_ID = "FAM_DEMO_001"

# Sex: 1=male 2=female; affected: 1=unaffected 2=affected
PED_ROWS = [
    (FAMILY_ID, PROBAND_ID, FATHER_ID, MOTHER_ID, "1", "2"),  # affected male proband
    (FAMILY_ID, FATHER_ID,  "0",       "0",       "1", "1"),
    (FAMILY_ID, MOTHER_ID,  "0",       "0",       "2", "1"),
]


def genotypes_for(v: DemoVariant) -> tuple[str, str, str]:
    """Return (proband_gt, father_gt, mother_gt) for a given pattern."""
    p = v.pattern
    if p == "de_novo":          return "0/1", "0/0", "0/0"
    if p == "ar_hom":           return "1/1", "0/1", "0/1"
    if p == "comp_het_pat":     return "0/1", "0/1", "0/0"
    if p == "comp_het_mat":     return "0/1", "0/0", "0/1"
    if p == "ad_inherited_pat": return "0/1", "0/1", "0/0"
    if p == "x_linked_rec":
        # male proband hemizygous → represented as 1 (or 1/1) for X
        return "1", "0", "0/1"
    if p == "carrier_both":     return "0/0", "0/1", "0/1"
    if p == "benign_common":    return "0/1", "0/1", "1/1"
    raise ValueError(f"unknown pattern {p!r}")


HEADER_TEMPLATE = """##fileformat=VCFv4.2
##fileDate={today}
##source=variantgpt_demo
##reference=GRCh38
##INFO=<ID=GENE,Number=1,Type=String,Description="Gene symbol (demo)">
##INFO=<ID=NOTE,Number=1,Type=String,Description="Demo note">
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read depth">
##FORMAT=<ID=AD,Number=R,Type=Integer,Description="Allelic depth">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\t{sample}
"""


def write_vcf(path: Path, sample: str, gt_extractor) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [HEADER_TEMPLATE.format(today=date.today().isoformat(), sample=sample)]
    for v in DEMO_VARIANTS:
        gt = gt_extractor(v)
        if gt is None:
            continue
        # Pick a depth that won't trip the de_novo low-confidence flag (>=10) for parents.
        dp, ad = ("40", "20,20") if gt in ("0/1", "1") else ("42", "0,42") if gt in ("1/1",) else ("38", "38,0")
        info = f"GENE={v.gene};NOTE={v.note.replace(';', '_').replace(' ', '_')[:80]}"
        vcf_id = f"clinvar_{v.clinvar_id}" if v.clinvar_id else "."
        lines.append(
            f"{v.chrom}\t{v.pos}\t{vcf_id}\t{v.ref}\t{v.alt}\t60\tPASS\t"
            f"{info}\tGT:DP:AD\t{gt}:{dp}:{ad}\n"
        )
    path.write_text("".join(lines), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    write_vcf(OUT / "proband.vcf", PROBAND_ID, lambda v: genotypes_for(v)[0])
    write_vcf(OUT / "father.vcf",  FATHER_ID,  lambda v: genotypes_for(v)[1])
    write_vcf(OUT / "mother.vcf",  MOTHER_ID,  lambda v: genotypes_for(v)[2])

    ped_path = OUT / "family.ped"
    ped_path.write_text("\n".join("\t".join(row) for row in PED_ROWS) + "\n", encoding="utf-8")

    print(f"wrote {OUT} ({len(DEMO_VARIANTS)} variants, 3 members)")


if __name__ == "__main__":
    main()
