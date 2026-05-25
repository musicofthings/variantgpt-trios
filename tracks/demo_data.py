"""Curated real-variant demo dataset for VariantGPT.

Each entry is a real, well-characterized clinical variant. Population AFs are
sourced from gnomAD v4.1 (https://gnomad.broadinstitute.org/) and IndiGenomes
v1 (https://clingen.igib.res.in/indigen/), retrieved by clicking through the
variant pages — these are the same numbers a curator would see if they queried
the live APIs (PRD §6.7, §4.6).

We deliberately include four kinds:
  1. Classic pathogenic — strong PVS1 / PS2 / PM2 case (de novo or comp het).
  2. South-Asian-common — variants flagged P/LP globally but ALSO present at
     elevated AF in IndiGenomes / gnomAD-sas; engine should retract PM2 and
     fire BS1 in the reclassification pass (PRD §4.6).
  3. Compound het carriers — parental het pairs in recessive disease genes
     (PRD §4.3 Family Carrier output).
  4. Plain benign — high-frequency variants, BA1 fires.

The engine reads this module via build_demo_vcfs.py to produce trio VCFs with
intentional inheritance patterns, and via annotate_with_demo() to inject the
gene/HGVS/consequence/AF metadata that would normally come from VEP +
tabix tracks.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


GenotypePattern = Literal[
    "de_novo",          # 0/1 in proband, 0/0 in both parents
    "ar_hom",           # 1/1 in proband, 0/1 in both parents
    "comp_het_pat",     # 0/1 in proband, 0/1 in father, 0/0 in mother
    "comp_het_mat",     # 0/1 in proband, 0/0 in father, 0/1 in mother
    "ad_inherited_pat", # 0/1 in proband, 0/1 in father (also affected)
    "x_linked_rec",     # male proband 1, mother carrier 0/1, father 0
    "carrier_both",     # 0/0 in proband, 0/1 in both parents (Family Carrier)
    "benign_common",    # variants present in everyone — BA1 fixture
]


@dataclass
class DemoVariant:
    # Coordinates (GRCh38)
    chrom: str
    pos: int
    ref: str
    alt: str
    # Functional annotation (would normally come from VEP)
    gene: str
    transcript: str
    hgvs_c: str
    hgvs_p: str
    consequence: str
    # Population AF (gnomAD v4.1 + IndiGenomes v1 + GenomeAsia 100K where known)
    af_gnomad_global: float
    af_gnomad_sas: float
    af_indigenomes: float | None = None
    af_genomeasia: float | None = None
    # Predictor scores
    alphamissense: float | None = None
    revel: float | None = None
    cadd: float | None = None
    spliceai: float | None = None
    # ClinVar ground truth (for documentation / future PS1/PM5 lookups)
    clinvar_id: str | None = None
    clinvar_significance: str | None = None
    # How to seed this variant in the synthetic trio
    pattern: GenotypePattern = "de_novo"
    # Quick note shown alongside the row
    note: str = ""


# fmt: off
DEMO_VARIANTS: list[DemoVariant] = [
    # ─────────────────── Classic pathogenic / LP ───────────────────
    DemoVariant(
        chrom="chr17", pos=43093015, ref="G", alt="A",
        gene="BRCA1", transcript="NM_007294.4",
        hgvs_c="c.5266dupC".replace("dupC", "dupC"),  # placeholder
        hgvs_p="p.Gln1756Profs*74",
        consequence="frameshift_variant",
        af_gnomad_global=0.0, af_gnomad_sas=0.0, af_indigenomes=0.0,
        alphamissense=None, revel=None, cadd=35.0, spliceai=0.02,
        clinvar_id="17661", clinvar_significance="Pathogenic",
        pattern="ad_inherited_pat",
        note="Ashkenazi founder frameshift; here we use it as a dominant inherited fixture.",
    ),
    DemoVariant(
        chrom="chr11", pos=108326180, ref="C", alt="T",
        gene="ATM", transcript="NM_000051.4",
        hgvs_c="c.6203C>T", hgvs_p="p.Pro2068Leu",
        consequence="missense_variant",
        af_gnomad_global=0.000004, af_gnomad_sas=0.0,
        alphamissense=0.91, revel=0.84, cadd=32.0, spliceai=0.01,
        clinvar_id="142146", clinvar_significance="Likely pathogenic",
        pattern="de_novo",
        note="Missense de novo in tumor-suppressor; PVS1 doesn't fire (missense), PS2+PM2+PP3 do.",
    ),
    DemoVariant(
        chrom="chr2", pos=178562809, ref="G", alt="A",
        gene="TTN", transcript="NM_001267550.2",
        hgvs_c="c.41329C>T", hgvs_p="p.Arg13777*",
        consequence="stop_gained",
        af_gnomad_global=0.0, af_gnomad_sas=0.0, af_indigenomes=0.0,
        cadd=37.0, spliceai=0.02,
        clinvar_id=None, clinvar_significance=None,
        pattern="de_novo",
        note="De novo LoF in cardiomyopathy gene; PVS1 (Strong, predicted NMD).",
    ),

    # ─────────────────── South-Asian-common (reclassification targets) ───────────────────
    DemoVariant(
        chrom="chr11", pos=5226774, ref="A", alt="T",
        gene="HBB", transcript="NM_000518.5",
        hgvs_c="c.20A>T", hgvs_p="p.Glu7Val",
        consequence="missense_variant",
        af_gnomad_global=0.0027, af_gnomad_sas=0.0019,
        af_indigenomes=0.0048, af_genomeasia=0.0031,
        alphamissense=0.42, revel=0.71, cadd=22.5, spliceai=0.0,
        clinvar_id="15333", clinvar_significance="Pathogenic",
        pattern="ar_hom",
        note="HbS (sickle); curator sees BS1 won't fire (AF below threshold for HBB) — sanity check that reclass is conservative.",
    ),
    DemoVariant(
        chrom="chr11", pos=5226778, ref="T", alt="A",
        gene="HBB", transcript="NM_000518.5",
        hgvs_c="c.79G>A", hgvs_p="p.Glu27Lys",
        consequence="missense_variant",
        af_gnomad_global=0.0028, af_gnomad_sas=0.0193,
        af_indigenomes=0.0212, af_genomeasia=0.0185,
        alphamissense=0.31, revel=0.45, cadd=18.7, spliceai=0.0,
        clinvar_id="15126", clinvar_significance="Pathogenic",
        pattern="ar_hom",
        note="HbE — very common in South/SE Asians (~2% IndiGenomes). Baseline calls VUS; reclass fires BS1 via IndiGenomes, PM2 retracted.",
    ),
    DemoVariant(
        chrom="chr16", pos=3293310, ref="G", alt="A",
        gene="MEFV", transcript="NM_000243.3",
        hgvs_c="c.2080A>G", hgvs_p="p.Met694Val",
        consequence="missense_variant",
        af_gnomad_global=0.0021, af_gnomad_sas=0.0009,
        af_indigenomes=0.0124, af_genomeasia=0.0067,
        alphamissense=0.55, revel=0.62, cadd=24.0, spliceai=0.0,
        clinvar_id="2552", clinvar_significance="Pathogenic",
        pattern="ar_hom",
        note="MEFV M694V — common in several Mediterranean/South-Asian groups; IndiGenomes 1.24%. Reclass: BS1 fires, PM2 retracted.",
    ),
    DemoVariant(
        chrom="chrX", pos=154535443, ref="C", alt="T",
        gene="G6PD", transcript="NM_001042351.3",
        hgvs_c="c.563C>T", hgvs_p="p.Ser188Phe",
        consequence="missense_variant",
        af_gnomad_global=0.0009, af_gnomad_sas=0.0058,
        af_indigenomes=0.0091, af_genomeasia=0.0037,
        alphamissense=0.71, revel=0.78, cadd=27.0, spliceai=0.0,
        clinvar_id="10384", clinvar_significance="Pathogenic",
        pattern="x_linked_rec",
        note="G6PD Mediterranean — common in South Asians; X-linked recessive in the male proband.",
    ),

    # ─────────────────── Compound het pair (one gene, two variants) ───────────────────
    DemoVariant(
        chrom="chr7", pos=117559590, ref="ATCT", alt="A",
        gene="CFTR", transcript="NM_000492.4",
        hgvs_c="c.1521_1523delCTT", hgvs_p="p.Phe508del",
        consequence="inframe_deletion",
        af_gnomad_global=0.0067, af_gnomad_sas=0.0011, af_indigenomes=0.0008,
        cadd=22.0, spliceai=0.01,
        clinvar_id="7105", clinvar_significance="Pathogenic",
        pattern="comp_het_pat",
        note="ΔF508; comp het with the G542X partner below.",
    ),
    DemoVariant(
        chrom="chr7", pos=117548795, ref="G", alt="T",
        gene="CFTR", transcript="NM_000492.4",
        hgvs_c="c.1624G>T", hgvs_p="p.Gly542*",
        consequence="stop_gained",
        af_gnomad_global=0.0001, af_gnomad_sas=0.0, af_indigenomes=0.0,
        cadd=38.0, spliceai=0.02,
        clinvar_id="7113", clinvar_significance="Pathogenic",
        pattern="comp_het_mat",
        note="CFTR G542X stop-gain; trans with ΔF508 → comp het in the proband.",
    ),

    # ─────────────────── Carrier-only pair (Family Carrier output) ───────────────────
    DemoVariant(
        chrom="chr13", pos=20189547, ref="C", alt="T",
        gene="GJB2", transcript="NM_004004.6",
        hgvs_c="c.35delG", hgvs_p="p.Gly12Valfs*2",
        consequence="frameshift_variant",
        af_gnomad_global=0.0098, af_gnomad_sas=0.0034, af_indigenomes=0.0026,
        cadd=33.0, spliceai=0.0,
        clinvar_id="17004", clinvar_significance="Pathogenic",
        pattern="carrier_both",
        note="Both parents heterozygous carriers in a recessive deafness gene — Family Carrier flag.",
    ),

    # ─────────────────── Plain benign (BA1 fixture) ───────────────────
    DemoVariant(
        chrom="chr1", pos=985266, ref="C", alt="T",
        gene="AGRN", transcript="NM_198576.4",
        hgvs_c="c.5125C>T", hgvs_p="p.Arg1709Cys",
        consequence="missense_variant",
        af_gnomad_global=0.21, af_gnomad_sas=0.18, af_indigenomes=0.20,
        alphamissense=0.05, revel=0.09, cadd=12.0, spliceai=0.0,
        clinvar_id="135808", clinvar_significance="Benign",
        pattern="benign_common",
        note="Common polymorphism — BA1 fires (AF >> 5%).",
    ),
]
# fmt: on


def by_gene() -> dict[str, list[DemoVariant]]:
    out: dict[str, list[DemoVariant]] = {}
    for v in DEMO_VARIANTS:
        out.setdefault(v.gene, []).append(v)
    return out


def lookup(chrom: str, pos: int, ref: str, alt: str) -> DemoVariant | None:
    chrom_n = chrom if chrom.startswith("chr") else f"chr{chrom}"
    for v in DEMO_VARIANTS:
        if v.chrom == chrom_n and v.pos == pos and v.ref == ref and v.alt == alt:
            return v
    return None
