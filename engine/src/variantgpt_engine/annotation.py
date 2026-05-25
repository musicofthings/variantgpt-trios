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

from .annotation_sources import gnomad
from .annotation_sources.tabix_track import TrackConfig, lookup_all as tabix_lookup
from .joint import JointVariant
from .models import PopulationAF, PredictorScores, Variant

log = logging.getLogger(__name__)


@dataclass
class AnnotationContext:
    build: str
    track_versions: dict[str, str] = field(default_factory=dict)
    tracks: list[TrackConfig] = field(default_factory=list)
    use_gnomad: bool = True
    gnomad_timeout: float = 5.0
    use_demo_annotations: bool = False


def annotate(jv: JointVariant, ctx: AnnotationContext) -> Variant:
    v = Variant(
        id=f"{jv.chrom}:{jv.pos}:{jv.ref}:{jv.alt}",
        chrom=jv.chrom,
        pos=jv.pos,
        ref=jv.ref,
        alt=jv.alt,
        populations=_population_af(jv, ctx),
        predictors=_predictors(jv, ctx),
    )
    if ctx.use_demo_annotations:
        _apply_demo_annotation(v)
    return v


def _apply_demo_annotation(v: Variant) -> None:
    """Inject gene / HGVS / consequence / AFs / predictors from the curated
    demo dataset (tracks/demo_data.py). Used by the build_demo_case.py
    pipeline so the engine can run on Windows without VEP/tabix/gnomAD
    network calls and still produce a fully-populated case.json.

    Real cases route through VEP + tabix + live gnomAD instead.
    """
    try:
        import sys
        from pathlib import Path
        root = Path(__file__).resolve().parents[3]
        tracks_dir = str(root / "tracks")
        if tracks_dir not in sys.path:
            sys.path.insert(0, tracks_dir)
        from demo_data import lookup  # type: ignore
    except Exception:
        log.warning("demo annotation requested but tracks/demo_data.py not importable")
        return

    d = lookup(v.chrom, v.pos, v.ref, v.alt)
    if d is None:
        return

    v.gene = d.gene
    v.transcript = d.transcript
    v.hgvs_c = d.hgvs_c
    v.hgvs_p = d.hgvs_p
    v.consequence = d.consequence

    # Replace populations with the curated AFs (drop the live-gnomAD placeholder
    # if it returned nothing in this offline environment).
    pops: list[PopulationAF] = []
    pops.append(PopulationAF(source="gnomad_v4_global", af=d.af_gnomad_global))
    pops.append(PopulationAF(source="gnomad_v4_sas", af=d.af_gnomad_sas))
    if d.af_indigenomes is not None:
        pops.append(PopulationAF(source="indigenomes", af=d.af_indigenomes))
    if d.af_genomeasia is not None:
        pops.append(PopulationAF(source="genomeasia", af=d.af_genomeasia))
    v.populations = pops

    v.predictors = PredictorScores(
        alphamissense=d.alphamissense,
        revel=d.revel,
        cadd=d.cadd,
        spliceai=d.spliceai,
    )


def _population_af(jv: JointVariant, ctx: AnnotationContext) -> list[PopulationAF]:
    out: list[PopulationAF] = []
    if ctx.use_gnomad:
        out.extend(gnomad.lookup(jv.chrom, jv.pos, jv.ref, jv.alt, timeout=ctx.gnomad_timeout))
    if ctx.tracks:
        out.extend(tabix_lookup(jv.chrom, jv.pos, jv.ref, jv.alt, ctx.tracks))
    return out


def _predictors(jv: JointVariant, ctx: AnnotationContext) -> PredictorScores:
    # dbNSFP adapter lands here — it's a tabix track too, but with one row per
    # variant and ~20 score columns; modeled separately for readability.
    return PredictorScores()
