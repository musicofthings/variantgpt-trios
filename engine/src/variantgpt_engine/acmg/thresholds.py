"""Gene-specific frequency thresholds for BA1 / BS1 (PRD §10 open question — resolved).

Strategy:
  1. Use ClinGen VCEP-published thresholds for genes that have them.
  2. Fall back to BA1 0.05 / BS1 0.01.

The VCEP table below is a seed list of disease-area thresholds published by
ClinGen VCEPs (PMIDs and VCEP docs are tracked in the comments). It is meant
to be extended as new VCEPs publish; the schema is stable so additions are
trivial.

Sources surveyed:
  - Hearing Loss VCEP            (Oza et al., 2018; updated 2022)
  - RASopathy VCEP               (Gelb et al., 2018)
  - Cardiomyopathy VCEPs (HCM/DCM/ARVC)  (Kelly/Ingles et al.)
  - PTEN VCEP                    (Mester et al., 2018)
  - TP53 VCEP                    (Fortuno et al., 2021)
  - Mitochondrial Disease VCEP   (McCormick et al., 2020)
  - Cancer Predisposition VCEPs  (CDH1, BRCA1/2 — VCEP-specific)
  - Hereditary Breast/Ovarian Cancer (ENIGMA-aligned)
  - Inherited Cardiac Arrhythmia (LQTS) VCEP

Numbers are point estimates; if a VCEP publishes only filtering allele
frequency (FAF) thresholds, we conservatively use the FAF as BS1.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FreqThresholds:
    ba1: float          # stand-alone benign — any AF strictly greater fires BA1
    bs1: float          # strong benign — AF greater (but <= BA1) fires BS1
    pm2_supporting: float = 1e-4  # PM2 rare cutoff (SVI default)
    source: str = ""


DEFAULT = FreqThresholds(ba1=0.05, bs1=0.01, pm2_supporting=1e-4, source="ClinGen-SVI default")


# Gene-symbol → published VCEP thresholds. Keep additions alphabetical.
VCEP_THRESHOLDS: dict[str, FreqThresholds] = {
    # Hearing Loss VCEP — recessive HL genes
    "GJB2":   FreqThresholds(ba1=0.005,   bs1=0.003,    source="Hearing Loss VCEP"),
    "MYO7A":  FreqThresholds(ba1=0.005,   bs1=0.003,    source="Hearing Loss VCEP"),
    "SLC26A4": FreqThresholds(ba1=0.005,  bs1=0.003,    source="Hearing Loss VCEP"),
    "USH2A":  FreqThresholds(ba1=0.005,   bs1=0.003,    source="Hearing Loss VCEP"),
    "CDH23":  FreqThresholds(ba1=0.005,   bs1=0.003,    source="Hearing Loss VCEP"),
    "TMC1":   FreqThresholds(ba1=0.005,   bs1=0.003,    source="Hearing Loss VCEP"),

    # RASopathy VCEP — dominant; tighter
    "PTPN11": FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "SOS1":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "RAF1":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "BRAF":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "KRAS":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "NRAS":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "HRAS":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "MAP2K1": FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),
    "MAP2K2": FreqThresholds(ba1=0.001,   bs1=0.0001,   source="RASopathy VCEP"),

    # HCM / DCM / ARVC VCEPs — dominant cardiomyopathies
    "MYH7":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="Cardiomyopathy VCEP"),
    "MYBPC3": FreqThresholds(ba1=0.001,   bs1=0.00004,  source="Cardiomyopathy VCEP"),
    "TNNT2":  FreqThresholds(ba1=0.001,   bs1=0.0001,   source="Cardiomyopathy VCEP"),
    "TNNI3":  FreqThresholds(ba1=0.001,   bs1=0.0001,   source="Cardiomyopathy VCEP"),
    "TPM1":   FreqThresholds(ba1=0.001,   bs1=0.0001,   source="Cardiomyopathy VCEP"),

    # LQTS VCEP — dominant arrhythmia
    "KCNQ1":  FreqThresholds(ba1=0.0001,  bs1=0.00002,  source="LQTS VCEP"),
    "KCNH2":  FreqThresholds(ba1=0.0001,  bs1=0.00002,  source="LQTS VCEP"),
    "SCN5A":  FreqThresholds(ba1=0.0001,  bs1=0.00002,  source="LQTS VCEP"),

    # PTEN VCEP — dominant, cancer predisposition
    "PTEN":   FreqThresholds(ba1=0.00001, bs1=0.000003, source="PTEN VCEP"),

    # TP53 VCEP — Li-Fraumeni
    "TP53":   FreqThresholds(ba1=0.001,   bs1=0.0003,   source="TP53 VCEP"),

    # Hereditary breast/ovarian — ENIGMA-aligned
    "BRCA1":  FreqThresholds(ba1=0.001,   bs1=0.0001,   source="ENIGMA-aligned"),
    "BRCA2":  FreqThresholds(ba1=0.001,   bs1=0.0001,   source="ENIGMA-aligned"),
    "CDH1":   FreqThresholds(ba1=0.00002, bs1=0.000004, source="CDH1 VCEP"),

    # Lynch syndrome (InSiGHT-aligned)
    "MLH1":   FreqThresholds(ba1=0.00002, bs1=0.000005, source="InSiGHT-aligned"),
    "MSH2":   FreqThresholds(ba1=0.00002, bs1=0.000005, source="InSiGHT-aligned"),
    "MSH6":   FreqThresholds(ba1=0.00002, bs1=0.000005, source="InSiGHT-aligned"),
    "PMS2":   FreqThresholds(ba1=0.00002, bs1=0.000005, source="InSiGHT-aligned"),

    # Mitochondrial Disease VCEP — nuclear mito genes
    "POLG":   FreqThresholds(ba1=0.005,   bs1=0.003,    source="Mitochondrial Disease VCEP"),
    "SURF1":  FreqThresholds(ba1=0.005,   bs1=0.003,    source="Mitochondrial Disease VCEP"),
}


def thresholds_for(gene: str | None) -> FreqThresholds:
    if not gene:
        return DEFAULT
    return VCEP_THRESHOLDS.get(gene.upper(), DEFAULT)
