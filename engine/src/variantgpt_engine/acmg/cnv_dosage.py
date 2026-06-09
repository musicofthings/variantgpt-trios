"""ClinGen dosage-sensitivity scores for the CNV classifier (Riggs et al. 2020).

ClinGen's Dosage Sensitivity Map assigns each gene/region a haploinsufficiency
(HI) and triplosensitivity (TS) score:
    3  sufficient evidence (ESTABLISHED dosage-sensitive)
    2  emerging evidence
    1  little evidence
    0  no evidence
    30 gene associated with autosomal-recessive phenotype
    40 dosage sensitivity unlikely

In production these come from AnnotSV (which embeds the ClinGen map and gnomAD
pLI). This module is the in-engine fallback/seed used when AnnotSV did not
annotate a gene — mirroring acmg/thresholds.py and acmg/dosage.py. Extend as
ClinGen publishes; the schema is stable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class DosageScore:
    hi: Optional[int] = None   # haploinsufficiency score
    ts: Optional[int] = None   # triplosensitivity score


# Gene symbol → ClinGen dosage scores. Seed list of well-established entries.
DOSAGE: dict[str, DosageScore] = {
    # Established haploinsufficient (HI=3) — deletion drives disease
    "BRCA1": DosageScore(hi=3), "BRCA2": DosageScore(hi=3),
    "TP53":  DosageScore(hi=3), "PTEN":  DosageScore(hi=3),
    "NF1":   DosageScore(hi=3), "NF2":   DosageScore(hi=3),
    "RB1":   DosageScore(hi=3), "APC":   DosageScore(hi=3),
    "VHL":   DosageScore(hi=3), "TSC1":  DosageScore(hi=3),
    "TSC2":  DosageScore(hi=3), "SMAD4": DosageScore(hi=3),
    "MLH1":  DosageScore(hi=3), "MSH2":  DosageScore(hi=3),
    "DMD":   DosageScore(hi=3),
    "SCN1A": DosageScore(hi=3), "MECP2": DosageScore(hi=3, ts=3),   # MECP2 dup syndrome → TS=3
    "CHD7":  DosageScore(hi=3), "NSD1":  DosageScore(hi=3),
    "EHMT1": DosageScore(hi=3), "TCF4":  DosageScore(hi=3),
    "SHANK3": DosageScore(hi=3),
    # Established triplosensitive (TS=3) — duplication drives disease
    "PMP22": DosageScore(hi=3, ts=3),   # del → HNPP, dup → CMT1A
    "PLP1":  DosageScore(ts=3),         # dup → Pelizaeus-Merzbacher
    "SNCA":  DosageScore(ts=3),
    # Recessive (deletion of one copy not sufficient alone) — HI=30
    "GJB2":  DosageScore(hi=30), "SLC26A4": DosageScore(hi=30),
}


def dosage_for(gene: str | None) -> DosageScore:
    if not gene:
        return DosageScore()
    return DOSAGE.get(gene.upper(), DosageScore())


def hi_score(gene: str | None) -> Optional[int]:
    return dosage_for(gene).hi


def ts_score(gene: str | None) -> Optional[int]:
    return dosage_for(gene).ts
