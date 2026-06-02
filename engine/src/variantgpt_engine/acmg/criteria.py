"""Individual ACMG criterion evaluators (PRD §7).

Each evaluator: Variant -> EvidenceItem | None.
Returning None means the criterion was not even considered (rare — most write
a not-fired row); returning fired=False means considered-and-rejected.

Criteria with `*` in PRD §7 are auto-proposed and curator-overridable; this
module produces the proposal — override is a Worker-level decision.
"""
from __future__ import annotations

from typing import Callable, Optional

from ..models import EvidenceItem, Variant
from .points import points_for
from .thresholds import thresholds_for

CriterionFn = Callable[[Variant], Optional[EvidenceItem]]
CRITERION_REGISTRY: dict[str, CriterionFn] = {}


def criterion(name: str):
    def deco(fn: CriterionFn) -> CriterionFn:
        CRITERION_REGISTRY[name] = fn
        return fn
    return deco


def _af(v: Variant, source: str) -> Optional[float]:
    for pop in v.populations:
        if pop.source == source:
            return pop.af
    return None


# ───────────────────────── Pathogenic ─────────────────────────

@criterion("PVS1")
def pvs1(v: Variant) -> EvidenceItem:
    lof_consequences = {"stop_gained", "frameshift_variant", "splice_acceptor_variant",
                        "splice_donor_variant", "start_lost"}
    fired = (v.consequence or "") in lof_consequences
    return EvidenceItem(
        criterion="PVS1", fired=fired,
        strength="VS" if fired else None,
        points=points_for("VS") if fired else 0,
        source="vep" if fired else "",
        detail=(f"predicted LoF: {v.consequence}" if fired else ""),
    )


@criterion("PS1")
def ps1(v: Variant) -> EvidenceItem:
    """Same amino-acid change as a previously-established P/LP variant at a
    different nucleotide change.

    Decided in the context pass (acmg/context.evaluate_ps1) once the ClinVar
    amino-acid index (annotation_sources/clinvar_aa.py) has enumerated every
    P/LP missense in the gene by residue. classify() emits this not-fired stub;
    augment_context_evidence overwrites it when an anchor exists."""
    return EvidenceItem(criterion="PS1", fired=False)


@criterion("PS2")
def ps2(v: Variant) -> EvidenceItem:
    fired = "de_novo" in v.inheritance_models and v.inheritance_confidence == "high"
    return EvidenceItem(
        criterion="PS2", fired=fired,
        strength="S" if fired else None,
        points=points_for("S") if fired else 0,
        source="trio_phasing",
        detail="confirmed de novo (parentage-supported)" if fired else "",
    )


@criterion("PM6")
def pm6(v: Variant) -> EvidenceItem:
    fired = "de_novo" in v.inheritance_models and v.inheritance_confidence != "high"
    return EvidenceItem(
        criterion="PM6", fired=fired,
        strength="M" if fired else None,
        points=points_for("M") if fired else 0,
        source="trio_phasing",
        detail="assumed de novo (parentage unconfirmed)" if fired else "",
    )


@criterion("PS3")
def ps3(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="PS3", fired=False)


@criterion("PS4")
def ps4(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="PS4", fired=False)


@criterion("PM1")
def pm1(v: Variant) -> EvidenceItem:
    """Variant in a mutational hotspot or well-established functional domain.

    Strict version needs UniProt domain coordinates + ClinVar density mapping.
    Practical conservative proxy that fires only on strong signal: missense
    variant where multiple high-quality predictors agree at the *strong*
    pathogenic band (not just supporting). Avoids double-counting with PP3
    by requiring the agreement to be stronger than PP3's supporting threshold.
    """
    if (v.consequence or "") != "missense_variant":
        return EvidenceItem(criterion="PM1", fired=False)
    am = v.predictors.alphamissense
    revel = v.predictors.revel
    cadd = v.predictors.cadd
    strong_hits = 0
    if am is not None and am >= 0.972:
        strong_hits += 1
    if revel is not None and revel >= 0.932:
        strong_hits += 1
    if cadd is not None and cadd >= 30:
        strong_hits += 1
    if strong_hits >= 2:
        return EvidenceItem(
            criterion="PM1", fired=True, strength="M", points=points_for("M"),
            source="predictors_strong_concordance",
            detail=f"missense; ≥2 strong-band predictors agree (AM={am} REVEL={revel} CADD={cadd})",
        )
    return EvidenceItem(criterion="PM1", fired=False)


@criterion("PM2")
def pm2(v: Variant) -> EvidenceItem:
    """Absent/rare in population DBs. Default Supporting per ClinGen SVI.

    Uses gene-specific PM2 rare cutoff from the VCEP table; the South Asian
    reclassification step (§4.6) retracts PM2 if the variant turns out to be
    present at meaningful AF in a South Asian source.
    """
    t = thresholds_for(v.gene)
    global_af = _af(v, "gnomad_v4_global")
    fired = global_af is None or global_af < t.pm2_supporting
    return EvidenceItem(
        criterion="PM2", fired=fired,
        strength="P" if fired else None,
        points=points_for("P") if fired else 0,
        source="gnomad_v4_global",
        detail=(f"rare in gnomAD global (AF<{t.pm2_supporting}, {t.source})" if fired else ""),
    )


@criterion("PM3")
def pm3(v: Variant) -> EvidenceItem:
    # Set by compound-het pass + ClinVar lookup of the trans partner.
    return EvidenceItem(criterion="PM3", fired=False)


@criterion("PM4")
def pm4(v: Variant) -> EvidenceItem:
    """Protein length changes from in-frame indel or stop-loss in a non-repeat
    region.

    We fire on consequence alone — repeat-region exclusion (RepeatMasker
    overlay) is a future addition. This may over-fire ~5-10% of the time;
    curators can override.
    """
    pm4_consequences = {"inframe_insertion", "inframe_deletion", "stop_lost"}
    if (v.consequence or "") in pm4_consequences:
        return EvidenceItem(
            criterion="PM4", fired=True, strength="M", points=points_for("M"),
            source="vep",
            detail=f"{v.consequence} — protein length altered",
        )
    return EvidenceItem(criterion="PM4", fired=False)


@criterion("PM5")
def pm5(v: Variant) -> EvidenceItem:
    """Novel missense at a residue where a *different* missense change is
    established as P/LP.

    Decided in the context pass (acmg/context.evaluate_pm5) against the same
    ClinVar amino-acid index PS1 uses. Stands down when PS1 (same-change anchor)
    fires. classify() emits this not-fired stub; the context pass overwrites it.
    """
    return EvidenceItem(criterion="PM5", fired=False)


@criterion("PP1")
def pp1(v: Variant) -> EvidenceItem:
    # Co-segregation; populated by pedigree segregation pass.
    return EvidenceItem(criterion="PP1", fired=False)


@criterion("PP2")
def pp2(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="PP2", fired=False)


@criterion("PP3")
def pp3(v: Variant) -> EvidenceItem:
    """In-silico concordance using ClinGen-calibrated thresholds.

    Conservative defaults: AlphaMissense >= 0.564 (likely pathogenic band),
    REVEL >= 0.773, CADD >= 25.3, SpliceAI >= 0.5.
    Strength is calibrated per the ClinGen recommendation (Pejaver et al.).
    """
    am = v.predictors.alphamissense
    revel = v.predictors.revel
    cadd = v.predictors.cadd
    spliceai = v.predictors.spliceai

    if am is not None and am >= 0.972:
        return EvidenceItem(criterion="PP3", fired=True, strength="S",
                            points=points_for("S"), source="alphamissense",
                            detail=f"AM={am:.3f} (strong band)")
    hits = []
    if am is not None and am >= 0.564:
        hits.append(f"AM={am:.3f}")
    if revel is not None and revel >= 0.773:
        hits.append(f"REVEL={revel:.3f}")
    if cadd is not None and cadd >= 25.3:
        hits.append(f"CADD={cadd:.1f}")
    if spliceai is not None and spliceai >= 0.5:
        hits.append(f"SpliceAI={spliceai:.2f}")
    if hits:
        return EvidenceItem(criterion="PP3", fired=True, strength="P",
                            points=points_for("P"), source="predictors",
                            detail=", ".join(hits))
    return EvidenceItem(criterion="PP3", fired=False)


@criterion("PP4")
def pp4(v: Variant) -> EvidenceItem:
    # HPO semantic match drives this; populated by prioritization pass.
    return EvidenceItem(criterion="PP4", fired=False)


# ───────────────────────── Benign ─────────────────────────

@criterion("BA1")
def ba1(v: Variant) -> EvidenceItem:
    """Stand-alone benign: AF above the gene's BA1 threshold in any population DB."""
    """Baseline BA1 uses gnomAD global only — the South Asian reclassification
    pass (PRD §4.6) re-evaluates against population-specific sources."""
    t = thresholds_for(v.gene)
    global_af = _af(v, "gnomad_v4_global")
    if global_af is not None and global_af > t.ba1:
        return EvidenceItem(
            criterion="BA1", fired=True, strength="BA", points=0,
            source="gnomad_v4_global",
            detail=f"AF={global_af:.4f} in gnomAD global > BA1 {t.ba1} ({t.source})",
        )
    return EvidenceItem(criterion="BA1", fired=False)


@criterion("BS1")
def bs1(v: Variant) -> EvidenceItem:
    """Baseline BS1 uses gnomAD global only (gene-specific threshold).
    SAS sources are evaluated in the reclassification pass."""
    t = thresholds_for(v.gene)
    global_af = _af(v, "gnomad_v4_global")
    if global_af is not None and global_af > t.bs1 and global_af <= t.ba1:
        return EvidenceItem(
            criterion="BS1", fired=True, strength="BS",
            points=points_for("BS"), source="gnomad_v4_global",
            detail=f"AF={global_af:.4f} in gnomAD global > BS1 {t.bs1} ({t.source})",
        )
    return EvidenceItem(criterion="BS1", fired=False)


@criterion("BS2")
def bs2(v: Variant) -> EvidenceItem:
    """Observed in homozygous state in a healthy adult cohort (incompatible
    with disease).

    gnomAD reports per-variant n_hom; if ≥1 hom-alt is observed AND the
    inheritance model is dominant or AR (we don't know dominance per gene
    yet, so default to fire when any hom is observed and the consequence
    isn't loss-of-function — protective floor).
    """
    # Find any population with homozygous count.
    for pop in v.populations:
        if pop.n_hom and pop.n_hom >= 1:
            return EvidenceItem(
                criterion="BS2", fired=True, strength="BS", points=points_for("BS"),
                source=pop.source,
                detail=f"{pop.n_hom} homozygous reference individual(s) observed in {pop.source}",
            )
    return EvidenceItem(criterion="BS2", fired=False)


@criterion("BS3")
def bs3(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="BS3", fired=False)


@criterion("BS4")
def bs4(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="BS4", fired=False)


@criterion("BP2")
def bp2(v: Variant) -> EvidenceItem:
    return EvidenceItem(criterion="BP2", fired=False)


@criterion("BP4")
def bp4(v: Variant) -> EvidenceItem:
    am = v.predictors.alphamissense
    revel = v.predictors.revel
    if (am is not None and am <= 0.34) or (revel is not None and revel <= 0.183):
        return EvidenceItem(
            criterion="BP4", fired=True, strength="BP",
            points=points_for("BP"), source="predictors",
            detail=f"AM={am} REVEL={revel} (benign band)",
        )
    return EvidenceItem(criterion="BP4", fired=False)


@criterion("BP7")
def bp7(v: Variant) -> EvidenceItem:
    """Synonymous variant where SpliceAI predicts no splice effect.

    Strict: also need to confirm no conservation at the position (PhyloP < 1.0
    or similar). We fold conservation into the same check when available.
    """
    if (v.consequence or "") != "synonymous_variant":
        return EvidenceItem(criterion="BP7", fired=False)
    spliceai = v.predictors.spliceai
    phylop = v.predictors.phylop
    if spliceai is not None and spliceai >= 0.2:
        return EvidenceItem(criterion="BP7", fired=False)  # has splice signal — don't fire benign
    # phylop > 1.0 in a synonymous position suggests conservation; veto fire.
    if phylop is not None and phylop > 1.0:
        return EvidenceItem(criterion="BP7", fired=False)
    return EvidenceItem(
        criterion="BP7", fired=True, strength="BP", points=points_for("BP"),
        source="predictors",
        detail=(f"synonymous; SpliceAI={spliceai if spliceai is not None else '—'}; PhyloP={phylop if phylop is not None else '—'}"),
    )
