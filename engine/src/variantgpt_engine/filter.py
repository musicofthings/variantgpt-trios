"""Pre-classification filters (PRD §4.3).

The ACMG classifier is per-variant work but only valuable for variants with
non-trivial pathogenicity priors. Common variants (AF ≥ 1% in any well-
powered cohort) get filtered out, and so do variants whose only annotated
consequence is benign-by-construction (intergenic, intronic non-splice,
synonymous in a non-spliceable context).

This stage shrinks 250k–500k joint variants from a clinical exome down to
~1k–10k candidates — the engine then does the expensive annotation +
classification only on the survivors.

Filters applied (configurable thresholds):
  - AF threshold: drop if max AF across populations ≥ MAX_AF (default 1%).
  - Consequence: drop if VEP CSQ Consequence is purely non-coding-non-splice
    (intergenic_variant, downstream_gene_variant, upstream_gene_variant,
    non_coding_transcript_variant) AND the variant has a CSQ at all.
    Variants without CSQ pass through (we can't judge them yet).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from .annotation_sources.csq import pick_canonical
from .joint import JointVariant
from .models import Affected, Pedigree


# Consequences we drop outright when seen. SO terms; VEP emits them
# comma-separated when multiple apply, but the canonical pick reports one.
BENIGN_CONSEQUENCES = frozenset({
    "intergenic_variant",
    "downstream_gene_variant",
    "upstream_gene_variant",
    "non_coding_transcript_variant",
    "non_coding_transcript_exon_variant",
    "regulatory_region_variant",
    "TF_binding_site_variant",
    "TFBS_ablation",
    "feature_elongation",
    "feature_truncation",
})


def proband_carrier_filter(
    joint: Iterable[JointVariant], pedigree: Pedigree,
) -> tuple[list[JointVariant], int]:
    """Drop variants the proband doesn't carry.

    Every inheritance model in trio analysis (de novo, AR hom, comp het, AD
    inherited, X-linked, mito) requires the proband to carry the variant
    (GT ∈ {0/1, 1/1, 1}). Sites where the proband is 0/0 or ./. cannot be
    candidates and shouldn't pay the cost of annotation.

    For multi-proband pedigrees: keep variants carried by ANY affected member.

    Returns (kept, dropped_count).
    """
    affected_ids = [m.id for m in pedigree.members if m.affected == Affected.affected]
    if not affected_ids:
        # No affected member identified — treat anyone listed as proband.
        affected_ids = [m.id for m in pedigree.members if m.role == "proband"]
    if not affected_ids:
        # Degenerate input — pass through.
        return list(joint), 0

    kept: list[JointVariant] = []
    dropped = 0
    for jv in joint:
        if any(jv.genotypes.get(mid) and jv.genotypes[mid] > 0 for mid in affected_ids):
            kept.append(jv)
        else:
            dropped += 1
    return kept, dropped


@dataclass
class FilterStats:
    total: int = 0
    kept: int = 0
    dropped_by_af: int = 0
    dropped_by_consequence: int = 0
    dropped_by_filter_field: int = 0


def filter_candidates(
    joint: Iterable[JointVariant],
    *,
    max_af: float = 0.01,
    drop_filtered: bool = True,
) -> tuple[list[JointVariant], FilterStats]:
    """Return (kept, stats). Pre-annotation filter pass.

    AF can come from two places at this stage:
      1. The VCF's own INFO/AF field (if the VCF was annotated by a pipeline
         that ran gnomAD/popfreq tracks server-side).
      2. CSQ entries from VEP that have AF or gnomADg_AF/gnomAD_AF columns.

    Variants without any AF signal are kept (we'll fetch AF live during the
    annotation stage; the per-variant gnomAD call gates further inclusion).
    """
    kept: list[JointVariant] = []
    stats = FilterStats()
    for jv in joint:
        stats.total += 1

        if drop_filtered and jv.filters:
            stats.dropped_by_filter_field += 1
            continue

        af = _max_af_from_csq(jv)
        if af is not None and af >= max_af:
            stats.dropped_by_af += 1
            continue

        if _consequence_is_benign(jv):
            stats.dropped_by_consequence += 1
            continue

        kept.append(jv)

    stats.kept = len(kept)
    return kept, stats


def _max_af_from_csq(jv: JointVariant) -> float | None:
    """Scan all CSQ entries for any AF-like field; return the maximum value
    found, or None if no AF field was annotated."""
    if not jv.csq:
        return None
    # VEP's standard AF fields; the most common in clinical pipelines.
    af_keys = (
        "gnomADe_AF", "gnomADg_AF", "gnomAD_AF",
        "AF", "MAX_AF",
        "1000G_AF",
    )
    seen: list[float] = []
    for entry in jv.csq:
        for k in af_keys:
            v = entry.get(k)
            if not v:
                continue
            try:
                seen.append(float(v))
            except ValueError:
                continue
    return max(seen) if seen else None


def _consequence_is_benign(jv: JointVariant) -> bool:
    """True if the variant has CSQ and its canonical Consequence is purely
    in the benign-by-construction set. Variants without CSQ return False
    (we can't judge them at this stage)."""
    chosen = pick_canonical(jv.csq)
    if not chosen:
        return False
    cons = (chosen.get("Consequence") or "").strip()
    if not cons:
        return False
    # Consequence can be multi-valued, comma- or &-delimited per VEP.
    tokens = {t for chunk in cons.replace(",", "&").split("&") if (t := chunk.strip())}
    return bool(tokens) and tokens.issubset(BENIGN_CONSEQUENCES)
