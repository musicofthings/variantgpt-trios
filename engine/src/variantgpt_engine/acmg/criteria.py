"""Individual ACMG criterion evaluators (PRD §7).

Each evaluator: Variant -> EvidenceItem | None.
Returning None means the criterion was not even considered (rare — most write
a not-fired row); returning fired=False means considered-and-rejected.

Criteria with `*` in PRD §7 are auto-proposed and curator-overridable; this
module produces the proposal — override is a Worker-level decision.
"""
from __future__ import annotations

from typing import Callable, Optional

from ..models import EvidenceItem, PopulationAF, Variant
from . import dosage
from .points import downgrade, points_for, weaker_strength
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


def _pop_row(v: Variant, source: str) -> Optional[PopulationAF]:
    """Return the PopulationAF row for a source, or None if that source was
    never consulted for this variant. Distinguishes 'queried and absent'
    (row present, af 0/None) from 'never looked' (no row) — the distinction
    PM2 needs so it doesn't fire on missing data."""
    for pop in v.populations:
        if pop.source == source:
            return pop
    return None


def _consequence_terms(v: Variant) -> set[str]:
    """VEP joins multiple consequences with '&' (and occasionally ','), e.g.
    'splice_donor_variant&intron_variant'. Split so membership tests see every
    term, not just the exact compound string."""
    raw = (v.consequence or "").replace(",", "&")
    return {t.strip() for t in raw.split("&") if t.strip()}


def _parse_exon(exon: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    """VEP EXON/INTRON come as 'rank/total' (e.g. '14/45'). Return (rank, total)."""
    if not exon or "/" not in exon:
        return None, None
    rank_s, total_s = exon.split("/", 1)
    try:
        return int(rank_s), int(total_s)
    except ValueError:
        return None, None


# ───────────────────────── Pathogenic ─────────────────────────

# LoF consequence → null-variant subtype, for PVS1 routing.
_LOF_CONSEQUENCES = {"stop_gained", "frameshift_variant", "splice_acceptor_variant",
                     "splice_donor_variant", "start_lost"}


@criterion("PVS1")
def pvs1(v: Variant) -> EvidenceItem:
    """Null variant (LoF) — graded by the ClinGen SVI / Abou Tayoun 2018
    decision tree rather than fired at VeryStrong on consequence alone.

    Gating (entry criterion): LoF must be an established disease mechanism for
    the gene (dosage.lof_mechanism). If it isn't, PVS1 does not fire; if the
    mechanism is uncurated, PVS1 is capped at Moderate as a conservative
    auto-proposal (curator-overridable).

    Strength modifiers we can evaluate from VEP fields:
      - NMD escape (variant in the last exon): downgrade one step. Without
        exon coordinates we treat only the terminal exon as NMD-escaping; the
        last-50bp-of-penultimate-exon rule needs CDS coordinates (future work).
      - start_lost: capped at Moderate (an alternative start codon may rescue).
    """
    terms = _consequence_terms(v)
    lof = terms & _LOF_CONSEQUENCES
    if not lof:
        return EvidenceItem(criterion="PVS1", fired=False)

    mech = dosage.lof_mechanism(v.gene)
    if mech == "none":
        return EvidenceItem(
            criterion="PVS1", fired=False, source="dosage",
            detail=(f"LoF ({', '.join(sorted(lof))}) not the disease mechanism "
                    f"for {v.gene} (gain-of-function / dominant-negative gene)"),
        )

    strength = "VS"
    notes: list[str] = []

    # start_lost never reaches VeryStrong — alternative initiation may rescue.
    if "start_lost" in lof:
        strength = weaker_strength(strength, "M")
        notes.append("start-loss (alt-start uncertainty)")

    # NMD escape: terminal-exon truncation.
    rank, total = _parse_exon(v.exon)
    if rank is not None and total is not None and rank == total and "start_lost" not in lof:
        down = downgrade(strength, 1)
        if down is None:
            return EvidenceItem(criterion="PVS1", fired=False, source="vep",
                                detail="NMD-escaping LoF downgraded below Supporting")
        strength = down
        notes.append(f"NMD-escaping (last exon {rank}/{total})")

    # Uncurated gene mechanism: cap at Moderate.
    if mech == "unknown":
        strength = weaker_strength(strength, "M")
        notes.append("gene LoF mechanism uncurated → capped Moderate")

    detail = f"predicted LoF ({', '.join(sorted(lof))}) in {v.gene or 'gene'}"
    if notes:
        detail += "; " + "; ".join(notes)
    return EvidenceItem(
        criterion="PVS1", fired=True, strength=strength,
        points=points_for(strength), source="vep+dosage", detail=detail,
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
    row = _pop_row(v, "gnomad_v4_global")
    # Missing-data guard: absence of *data* is not absence from the population.
    # PM2 only applies when gnomAD was actually consulted for this variant. The
    # gnomAD adapter emits an explicit af=0 row for queried-and-absent variants,
    # so a None row means "never looked" (offline/demo/lookup failure).
    if row is None:
        return EvidenceItem(
            criterion="PM2", fired=False, source="gnomad_v4_global",
            detail="not applied: no gnomAD frequency available for this variant",
        )
    af = row.af if row.af is not None else 0.0
    fired = af < t.pm2_supporting
    return EvidenceItem(
        criterion="PM2", fired=fired,
        strength="P" if fired else None,
        points=points_for("P") if fired else 0,
        source="gnomad_v4_global",
        detail=(f"rare/absent in gnomAD global (AF={af:.2e}<{t.pm2_supporting}, {t.source})"
                if fired else f"AF={af:.2e} ≥ PM2 cutoff {t.pm2_supporting}"),
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
