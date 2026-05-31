"""Context-aware ACMG criteria (PRD §7) — the ones that can't be decided from
a single variant in isolation and so run as a post-classification pass once
the rest of the annotation context exists:

  PP4 — patient phenotype is (highly) specific for the gene's disease.
        Driven by the HPO phenotype-relevance score (phenotype.py), which is
        computed *after* the per-variant classify() sweep.
  PM3 — for a recessive disorder, detected in trans with a pathogenic variant.
        Needs the gene-grouped comp-het configuration + the trans partner's
        ClinVar classification.
  PP1 — co-segregation with disease across the pedigree. Needs per-member
        genotype calls + affected status.

Each per-variant criterion stub in criteria.py emits a not-fired row at
classify() time; this pass overwrites that row with the real verdict and then
re-tallies the variant's baseline points + tier. Must run BEFORE the South
Asian reclassification pass (which reads the baseline).

PS3 (functional studies) is intentionally NOT implemented here: it requires a
functional-evidence dataset (e.g. MaveDB / ClinGen functional assertions) that
isn't wired into this engine. It remains an honest not-fired stub rather than a
fabricated call.
"""
from __future__ import annotations

import logging

from ..models import Affected, EvidenceItem, Pedigree, Variant
from .engine import DEFAULT_THRESHOLDS, Thresholds, tier_for
from .points import points_for

log = logging.getLogger(__name__)

# PP4: phenotype-relevance percent (default algorithm = Phrank) at/above which
# the patient's phenotype is considered specific enough to support pathogenicity.
# Conservative, supporting-strength only — curator-overridable.
PP4_FIRE_PERCENT = 60.0


# ───────────────────────── PP4 (phenotype) ─────────────────────────

def evaluate_pp4(v: Variant, algo: str = "phrank") -> EvidenceItem:
    """Fire PP4 (Supporting) when the variant's gene is strongly relevant to
    the case's recorded phenotype. Uses the precomputed phenotype-relevance
    score; never escalates above Supporting (standard ACMG PP4)."""
    rel = v.phenotype_relevance
    if rel is None:
        return EvidenceItem(criterion="PP4", fired=False)
    score = getattr(rel, algo, None) or rel.phrank
    pct = score.percent
    # Full direct coverage of every case term is a strong phenotype fit even if
    # the graded percent lands a little under the band.
    full_coverage = rel.coverage.percent >= 100.0
    if pct >= PP4_FIRE_PERCENT or full_coverage:
        matched = ", ".join(t.hpo_id for t in score.matched_terms[:4]) or "—"
        return EvidenceItem(
            criterion="PP4", fired=True, strength="P", points=points_for("P"),
            source="hpo_phenotype",
            detail=(
                f"phenotype relevance {pct:.0f}% ({algo}); "
                f"gene matches case terms {matched}"
            ),
        )
    return EvidenceItem(criterion="PP4", fired=False)


# ───────────────────────── PM3 (trans pathogenic) ─────────────────────────

_PATHOGENIC_SIG = ("pathogenic",)  # substring match, lowercased
_BENIGN_OR_CONFLICT = ("benign", "conflicting")


def _is_clinvar_pathogenic(v: Variant) -> bool:
    """True if the variant has a ClinVar P/LP classification with ≥1 review
    star and no benign/conflicting qualifier."""
    cv = v.clinvar
    if cv is None or not cv.clinical_significance:
        return False
    sig = cv.clinical_significance.lower()
    if any(b in sig for b in _BENIGN_OR_CONFLICT):
        return False
    if (cv.review_stars or 0) < 1:
        return False
    return any(p in sig for p in _PATHOGENIC_SIG)


def evaluate_pm3(variants: list[Variant]) -> dict[str, EvidenceItem]:
    """For each comp-het variant, fire PM3 (Moderate) when a *different*
    variant in the same gene — i.e. the trans partner implied by the comp-het
    configuration — carries a pathogenic ClinVar classification.

    Approximation: comp_het_pass has already established the trans
    configuration gene-wide, so a pathogenic partner in the same gene is taken
    as the in-trans pathogenic allele. Returns variant_id -> EvidenceItem only
    for variants where PM3 was evaluated (fired or considered)."""
    by_gene: dict[str, list[Variant]] = {}
    for v in variants:
        if v.gene and "comp_het" in v.inheritance_models:
            by_gene.setdefault(v.gene, []).append(v)

    out: dict[str, EvidenceItem] = {}
    for gene, vs in by_gene.items():
        if len(vs) < 2:
            continue
        for v in vs:
            partners = [
                p for p in vs
                if p.id != v.id and _is_clinvar_pathogenic(p)
            ]
            if partners:
                partner = partners[0]
                sig = partner.clinvar.clinical_significance if partner.clinvar else "pathogenic"
                out[v.id] = EvidenceItem(
                    criterion="PM3", fired=True, strength="M", points=points_for("M"),
                    source="clinvar_trans_partner",
                    detail=(
                        f"in trans with {partner.gene} "
                        f"{partner.hgvs_c or partner.id} (ClinVar {sig})"
                    ),
                )
            else:
                out[v.id] = EvidenceItem(criterion="PM3", fired=False)
    return out


# ───────────────────────── PP1 (co-segregation) ─────────────────────────

_CARRIER_ZYG = {"het", "hom_alt"}


def evaluate_pp1(v: Variant, pedigree: Pedigree) -> EvidenceItem:
    """Fire PP1 (Supporting) on clean co-segregation: ≥2 affected members
    carry the variant, no affected member is a confirmed non-carrier, and at
    least one unaffected member is a confirmed non-carrier (informative meiosis).

    Conservative by design: unaffected *carriers* are NOT counted against
    segregation (they may be recessive carriers / reduced-penetrance), so this
    does not fire spuriously on AR pedigrees. A standard single-affected trio
    has only one affected member and therefore never reaches the ≥2 bar — which
    is correct; a trio carries no segregation power on its own."""
    affected_ids = {m.id for m in pedigree.members if m.affected == Affected.affected}
    unaffected_ids = {m.id for m in pedigree.members if m.affected == Affected.unaffected}
    zyg = {c.member_id: c.zygosity for c in v.calls}

    affected_carriers = 0
    affected_noncarriers = 0
    for mid in affected_ids:
        z = zyg.get(mid)
        if z in _CARRIER_ZYG:
            affected_carriers += 1
        elif z == "hom_ref":
            affected_noncarriers += 1
    unaffected_noncarriers = sum(1 for mid in unaffected_ids if zyg.get(mid) == "hom_ref")

    if affected_carriers >= 2 and affected_noncarriers == 0 and unaffected_noncarriers >= 1:
        return EvidenceItem(
            criterion="PP1", fired=True, strength="P", points=points_for("P"),
            source="pedigree_segregation",
            detail=(
                f"co-segregates: {affected_carriers} affected carrier(s), "
                f"{unaffected_noncarriers} unaffected non-carrier(s)"
            ),
        )
    return EvidenceItem(criterion="PP1", fired=False)


# ───────────────────────── driver + re-tally ─────────────────────────

def _replace_evidence(v: Variant, item: EvidenceItem) -> None:
    """Overwrite the ledger row for item.criterion (added as a not-fired stub
    at classify() time); append if somehow absent."""
    for i, e in enumerate(v.evidence):
        if e.criterion == item.criterion:
            v.evidence[i] = item
            return
    v.evidence.append(item)


def retally(v: Variant, t: Thresholds = DEFAULT_THRESHOLDS) -> None:
    """Recompute baseline_points + baseline_tier from the (possibly augmented)
    evidence ledger. Mirrors acmg.engine.classify's tally."""
    total = 0
    ba1 = False
    for e in v.evidence:
        if e.fired:
            total += e.points
            if e.criterion == "BA1":
                ba1 = True
    v.baseline_points = total
    v.baseline_tier = tier_for(total, t, ba1=ba1)


def augment_context_evidence(
    variants: list[Variant],
    pedigree: Pedigree,
    algo: str = "phrank",
) -> dict[str, int]:
    """Run PP4 / PM3 / PP1 across the variant set and re-tally affected
    variants. Returns a count of how many variants each criterion newly fired
    on (for pipeline logging)."""
    pm3_map = evaluate_pm3(variants)
    fired = {"PP4": 0, "PM3": 0, "PP1": 0}
    for v in variants:
        before = {e.criterion: e.fired for e in v.evidence}

        pp4 = evaluate_pp4(v, algo=algo)
        _replace_evidence(v, pp4)

        pp1 = evaluate_pp1(v, pedigree)
        _replace_evidence(v, pp1)

        pm3 = pm3_map.get(v.id)
        if pm3 is not None:
            _replace_evidence(v, pm3)

        # Re-tally only if any of the three changed a not-fired → fired edge.
        changed = False
        for name, item in (("PP4", pp4), ("PM3", pm3), ("PP1", pp1)):
            if item is not None and item.fired and not before.get(name, False):
                fired[name] += 1
                changed = True
        if changed:
            retally(v)
    return fired
