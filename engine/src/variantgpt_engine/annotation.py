"""Annotation layer (PRD §4.4) — orchestrates per-variant adapters.

For each candidate variant we gather:
  - Functional: gene/transcript (MANE), HGVS c./p., consequence (VEP/ANNOVAR).
  - Clinical: ClinVar, optional HGMD, ClinGen.
  - Population: gnomAD v4 (global + sas), IndiGenomes, GenomeAsia, GenomeIndia.
  - Predictors (precomputed): AlphaMissense, REVEL, CADD, SpliceAI, dbNSFP,
    PhyloP/GERP.
  - Phenotype: gene→disease→HPO.

Each adapter is independently optional; missing adapters degrade gracefully.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

from .annotation_sources import gnomad
from .annotation_sources.csq import apply_csq
from .annotation_sources.tabix_track import TrackConfig, lookup_all as tabix_lookup
from .joint import JointVariant
from .models import MemberCall, Pedigree, PopulationAF, PredictorScores, Variant

log = logging.getLogger(__name__)


@dataclass
class AnnotationContext:
    build: str
    track_versions: dict[str, str] = field(default_factory=dict)
    tracks: list[TrackConfig] = field(default_factory=list)
    use_gnomad: bool = True
    gnomad_timeout: float = 5.0


def _genomic_hgvs(chrom: str, pos: int, ref: str, alt: str) -> str:
    """Render the variant in HGVS genomic notation (g.).

    SNV:        chr5:g.14363831C>T
    Insertion:  chr5:g.123_124insGGGG (anchor stripped)
    Deletion:   chr5:g.124del (single base) / chr5:g.124_126del (range)
    Complex:    chr5:g.124_126delinsGT
    """
    c = chrom if chrom.startswith("chr") else f"chr{chrom}"
    if not ref or not alt:
        return f"{c}:g.{pos}"
    if len(ref) == 1 and len(alt) == 1:
        return f"{c}:g.{pos}{ref}>{alt}"
    # Insertion: ref=G, alt=GTTAT → insTTAT after pos
    if len(ref) == 1 and len(alt) > 1 and alt.startswith(ref):
        return f"{c}:g.{pos}_{pos + 1}ins{alt[1:]}"
    # Deletion: ref=AGGG, alt=A → del at pos+1..pos+len(ref)-1
    if len(alt) == 1 and len(ref) > 1 and ref.startswith(alt):
        if len(ref) == 2:
            return f"{c}:g.{pos + 1}del"
        return f"{c}:g.{pos + 1}_{pos + len(ref) - 1}del"
    # Complex substitution / delins.
    if len(ref) == 1:
        return f"{c}:g.{pos}delins{alt}"
    return f"{c}:g.{pos}_{pos + len(ref) - 1}delins{alt}"


def _project_calls(jv: JointVariant, pedigree: Pedigree) -> list[MemberCall]:
    """Build a MemberCall list from the JointVariant's per-member dicts +
    the pedigree role assignments."""
    out: list[MemberCall] = []
    for m in pedigree.members:
        gt = jv.genotypes.get(m.id)
        zyg: str
        if gt is None:
            zyg = "missing"
        elif gt == 0:
            zyg = "hom_ref"
        elif gt == 1:
            zyg = "het"
        elif gt == 2:
            zyg = "hom_alt"
        else:
            zyg = "missing"
        out.append(MemberCall(
            member_id=m.id,
            role=m.role.value if hasattr(m.role, "value") else str(m.role),
            zygosity=zyg,
            depth=jv.depths.get(m.id),
            allele_balance=jv.allele_balance.get(m.id),
            gq=jv.gq.get(m.id),
        ))
    return out


def annotate(jv: JointVariant, ctx: AnnotationContext, pedigree: Optional[Pedigree] = None) -> Variant:
    v = Variant(
        id=f"{jv.chrom}:{jv.pos}:{jv.ref}:{jv.alt}",
        chrom=jv.chrom,
        pos=jv.pos,
        ref=jv.ref,
        alt=jv.alt,
        genomic_hgvs=_genomic_hgvs(jv.chrom, jv.pos, jv.ref, jv.alt),
        populations=_population_af(jv, ctx),
        predictors=_predictors(jv, ctx),
        calls=_project_calls(jv, pedigree) if pedigree else [],
    )
    # Prefer VEP CSQ if the input VCF was pre-annotated (most clinical pipelines
    # run VEP before sharing). Free, fast, no external calls. Live adapters
    # (gnomAD, tabix tracks, dbNSFP) fill the rest.
    apply_csq(v, jv)
    return v


def _population_af(jv: JointVariant, ctx: AnnotationContext) -> list[PopulationAF]:
    out: list[PopulationAF] = []
    if ctx.use_gnomad:
        out.extend(gnomad.lookup(jv.chrom, jv.pos, jv.ref, jv.alt, timeout=ctx.gnomad_timeout))
    if ctx.tracks:
        out.extend(tabix_lookup(jv.chrom, jv.pos, jv.ref, jv.alt, ctx.tracks))
    # IndiGenomes is filled in a separate bulk pass (annotation_sources/
    # indigenomes.fetch_for_variants_async) after gene assignment — the IGIB
    # API is gene-keyed, so per-variant lookups here would be wildly slow.
    return out


def _predictors(jv: JointVariant, ctx: AnnotationContext) -> PredictorScores:
    # dbNSFP adapter lands here — it's a tabix track too, but with one row per
    # variant and ~20 score columns; modeled separately for readability.
    return PredictorScores()
