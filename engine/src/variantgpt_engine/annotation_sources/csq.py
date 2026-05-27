"""Consume VEP CSQ annotations parsed from the VCF INFO field.

Most clinical VCFs come pre-annotated by VEP — when so, we get gene / HGVS /
consequence "for free" without needing to host VEP or hit its REST API. This
module picks the most clinically-relevant CSQ entry per variant and projects
it onto the Variant model.

Selection priority for the canonical transcript:
  1. MANE_SELECT or MANE_PLUS_CLINICAL match
  2. CANONICAL == "YES"
  3. Highest IMPACT (HIGH > MODERATE > LOW > MODIFIER)
  4. First entry (deterministic)
"""
from __future__ import annotations

from typing import Optional

from ..joint import JointVariant
from ..models import Variant

IMPACT_RANK = {"HIGH": 0, "MODERATE": 1, "LOW": 2, "MODIFIER": 3}


def has_csq(jv: JointVariant) -> bool:
    return bool(jv.csq)


def pick_canonical(csq_entries: list[dict[str, str]]) -> Optional[dict[str, str]]:
    """Return the single CSQ entry we want to surface in the UI."""
    if not csq_entries:
        return None
    # MANE first (best clinical transcript).
    for c in csq_entries:
        if c.get("MANE_SELECT") or c.get("MANE_PLUS_CLINICAL"):
            return c
    # Then CANONICAL.
    for c in csq_entries:
        if (c.get("CANONICAL") or "").upper() == "YES":
            return c
    # Then highest IMPACT.
    csq_sorted = sorted(csq_entries, key=lambda c: IMPACT_RANK.get(c.get("IMPACT", "MODIFIER"), 99))
    return csq_sorted[0]


def apply_csq(v: Variant, jv: JointVariant) -> bool:
    """Project the canonical CSQ entry onto the Variant. Returns True if any
    field was filled. No-op when the VCF wasn't VEP-annotated."""
    chosen = pick_canonical(jv.csq)
    if not chosen:
        return False
    # Some VEP outputs prefix gene symbol in SYMBOL; Ensembl gene id in Gene.
    gene = chosen.get("SYMBOL") or chosen.get("Gene") or None
    transcript = chosen.get("Feature") or chosen.get("MANE_SELECT") or None
    # HGVSc/HGVSp may be prefixed with transcript:; strip the prefix for UI cleanliness.
    hgvs_c = _strip_prefix(chosen.get("HGVSc"))
    hgvs_p = _strip_prefix(chosen.get("HGVSp"))
    consequence = chosen.get("Consequence") or None
    # EXON / INTRON come as "rank/total" e.g. "14/45". Keep as-is for the UI.
    exon = chosen.get("EXON") or None

    changed = False
    if gene and not v.gene:
        v.gene = gene
        changed = True
    if transcript and not v.transcript:
        v.transcript = transcript
        changed = True
    if hgvs_c and not v.hgvs_c:
        v.hgvs_c = hgvs_c
        changed = True
    if hgvs_p and not v.hgvs_p:
        v.hgvs_p = hgvs_p
        changed = True
    if consequence and not v.consequence:
        v.consequence = consequence
        changed = True
    if exon and not v.exon:
        v.exon = exon
        changed = True
    return changed


def _strip_prefix(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    # "ENST0...:c.123A>G" → "c.123A>G"
    if ":" in s:
        return s.split(":", 1)[1]
    return s
