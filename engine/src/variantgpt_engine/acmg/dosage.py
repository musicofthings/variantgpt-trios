"""Gene dosage-sensitivity / LoF disease-mechanism map for the PVS1 decision
tree (Abou Tayoun et al. 2018, ClinGen SVI; the algorithm Franklin implements).

PVS1 may only fire at full strength when loss-of-function is an *established*
disease mechanism for the gene (entry criterion of the decision tree). Firing
VeryStrong on consequence alone — as the old evaluator did — produces an LP
call for every truncating variant, including:
  - LoF in genes where the mechanism is gain-of-function / dominant-negative,
  - common LoF polymorphisms ClinVar curates Benign.

Strategy (mirrors thresholds.py — a seed list, extensible as ClinGen publishes):
  ESTABLISHED  → gene has ClinGen dosage HI=3 / well-established haploinsufficiency
                 or truncating-is-the-mechanism. PVS1 runs the full tree.
  NONE         → LoF is NOT the disease mechanism (activating GoF / dominant-
                 negative missense disorders). PVS1 does not fire.
  UNKNOWN      → mechanism not curated here. PVS1 fires at a capped (Moderate)
                 strength as a conservative auto-proposal — curator-overridable.

This is intentionally conservative: when in doubt we under-call PVS1 rather
than inflate to LP. The map is keyed by HGNC symbol (upper-cased on lookup).
"""
from __future__ import annotations

from typing import Literal

LoFMechanism = Literal["established", "none", "unknown"]


# Genes where loss-of-function / haploinsufficiency is an established disease
# mechanism (ClinGen dosage HI=3 or equivalent literature). Truncating variants
# are bona fide candidates for full-strength PVS1 here.
ESTABLISHED_LOF: frozenset[str] = frozenset({
    # Hereditary cancer — LoF/truncating pathogenic
    "BRCA1", "BRCA2", "PALB2", "ATM", "CHEK2", "TP53", "PTEN", "CDH1",
    "APC", "MUTYH", "NF1", "NF2", "RB1", "VHL", "TSC1", "TSC2", "STK11",
    "SMAD4", "BMPR1A", "DICER1", "BAP1", "FLCN",
    # Lynch syndrome mismatch repair — LoF
    "MLH1", "MSH2", "MSH6", "PMS2", "EPCAM",
    # Hearing loss (recessive) — LoF mechanism
    "GJB2", "SLC26A4", "MYO7A", "USH2A", "CDH23", "TMC1",
    # Mitochondrial (recessive) — LoF
    "POLG", "SURF1",
    # Cardiomyopathy where truncating IS the mechanism (haploinsufficiency)
    "MYBPC3",
    # Neurodevelopmental haploinsufficiency
    "SCN1A", "MECP2", "CHD7", "CHD8", "ARID1B", "KMT2D", "NSD1", "EHMT1",
    "ANKRD11", "SHANK3", "FOXG1", "TCF4", "ADNP",
    # X-linked LoF
    "DMD",
})


# Genes where LoF is NOT the disease mechanism — disease is caused by activating
# gain-of-function or dominant-negative missense, so a truncating allele should
# NOT trigger PVS1.
NO_LOF_MECHANISM: frozenset[str] = frozenset({
    # Achondroplasia / craniosynostosis — activating GoF
    "FGFR3", "FGFR2",
    # RASopathies — activating GoF / dominant
    "HRAS", "KRAS", "NRAS", "BRAF", "RAF1", "SOS1", "MAP2K1", "MAP2K2", "PTPN11",
    # HCM — dominant-negative missense; truncating is not the HCM mechanism
    "MYH7",
})


def lof_mechanism(gene: str | None) -> LoFMechanism:
    """Classify the gene's loss-of-function disease mechanism for PVS1 entry."""
    if not gene:
        return "unknown"
    g = gene.upper()
    if g in NO_LOF_MECHANISM:
        return "none"
    if g in ESTABLISHED_LOF:
        return "established"
    return "unknown"
