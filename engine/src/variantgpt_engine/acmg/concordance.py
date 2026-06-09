"""Engine-vs-ClinVar concordance check (PRD §4.5).

The engine computes an ACMG tier from evidence; ClinVar carries the community's
own assertion. When the two disagree at high confidence — e.g. the engine calls
LP but a 2★ ClinVar record says Benign — that is exactly the discrepancy a
curator needs to see surfaced (Franklin shows the ClinVar assertion as a
first-class line). ClinGen SVI retired PP5/BP6, so we do NOT inject ClinVar as
points or override the auto-tier; we only flag the disagreement.

`review_stars` (0–4) gauges confidence:
    4 practice guideline · 3 expert panel · 2 multiple submitters, no conflicts
    1 single submitter · 0 no assertion criteria.
Discordance is only asserted for ≥2★ records (multi-submitter and above);
1★/0★ assertions are treated as uninformative rather than contradicting.
"""
from __future__ import annotations

from typing import Optional, Union

from ..models import ClinVarConcordance, StructuralVariant, Tier, Variant

# Minimum review stars for a ClinVar assertion to be allowed to contradict the
# engine (multiple submitters with no conflicts, or better).
MIN_DISCORDANCE_STARS = 2

_PATHOGENIC = {"P", "LP"}
_BENIGN = {"B", "LB"}


def map_significance(sig: Optional[str]) -> Optional[Tier]:
    """Map a ClinVar clinical_significance string onto our 5-tier scale.
    Returns None for conflicting / uncertain / non-assertive values."""
    if not sig:
        return None
    s = sig.lower()
    if "conflict" in s:
        return None
    if "uncertain" in s or "vus" in s:
        return "VUS"
    has_likely = "likely" in s
    # Order matters: check pathogenic/benign keywords, factoring "likely".
    if "pathogenic" in s:
        return "LP" if has_likely and "/" not in s else "P"
    if "benign" in s:
        return "LB" if has_likely and "/" not in s else "B"
    return None


def _direction(tier: Optional[Tier]) -> Optional[str]:
    if tier in _PATHOGENIC:
        return "pathogenic"
    if tier in _BENIGN:
        return "benign"
    return None  # VUS / None — no directional commitment


def assess(item: Union[Variant, StructuralVariant], engine_tier: Optional[Tier]) -> Optional[ClinVarConcordance]:
    """Compare the engine tier to ClinVar for a sequence variant OR a structural
    variant (both carry a `clinvar` field). Returns None when there is no ClinVar
    record at all (nothing to reconcile)."""
    cv = item.clinvar
    if cv is None or not cv.clinical_significance:
        return None

    clinvar_tier = map_significance(cv.clinical_significance)
    stars = cv.review_stars or 0

    base = dict(
        engine_tier=engine_tier,
        clinvar_tier=clinvar_tier,
        clinvar_significance=cv.clinical_significance,
        review_stars=stars,
    )

    eng_dir = _direction(engine_tier)
    cv_dir = _direction(clinvar_tier)

    # Uninformative: ClinVar gives no directional signal, or it's too low-confidence.
    if cv_dir is None:
        return ClinVarConcordance(
            status="uninformative", note=f"ClinVar '{cv.clinical_significance}' carries no high-confidence direction",
            **base,
        )
    if stars < MIN_DISCORDANCE_STARS:
        return ClinVarConcordance(
            status="uninformative",
            note=f"ClinVar {cv_dir} but only {stars}★ (< {MIN_DISCORDANCE_STARS}★) — not weighed against engine",
            **base,
        )

    if eng_dir is not None and eng_dir != cv_dir:
        return ClinVarConcordance(
            status="discordant",
            note=(f"engine {engine_tier} ({eng_dir}) vs ClinVar {cv.clinical_significance} "
                  f"({cv_dir}, {stars}★) — curator review required"),
            **base,
        )

    return ClinVarConcordance(
        status="concordant",
        note=f"engine {engine_tier} agrees with ClinVar {cv.clinical_significance} ({stars}★)",
        **base,
    )


def assess_all(variants: list[Variant]) -> int:
    """Attach a ClinVarConcordance to each sequence variant. Uses the post-reclass
    tier when present (reclass_tier), else the baseline. Returns discordant count."""
    discordant = 0
    for v in variants:
        tier = v.reclass_tier or v.baseline_tier
        result = assess(v, tier)
        v.clinvar_concordance = result
        if result is not None and result.status == "discordant":
            discordant += 1
    return discordant


def assess_svs(svs: list[StructuralVariant]) -> int:
    """Attach a ClinVarConcordance to each structural variant (uses sv.tier).
    Returns the discordant count."""
    discordant = 0
    for sv in svs:
        result = assess(sv, sv.tier)
        sv.clinvar_concordance = result
        if result is not None and result.status == "discordant":
            discordant += 1
    return discordant
