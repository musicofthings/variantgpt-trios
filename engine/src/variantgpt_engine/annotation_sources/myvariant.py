"""myvariant.info adapter — ClinVar + dbNSFP predictors in one batched call.

Why this exists: myvariant.info aggregates ClinVar (per-variant clinical
significance + review status) and dbNSFP (REVEL, CADD, SpliceAI, AlphaMissense,
PhyloP, GERP, etc.) under one HGVS-keyed API. The batch endpoint accepts up
to 1000 variants per POST and is unrated.

Without this adapter the pipeline has:
  - No ClinVar overlay → ACMG criteria PS1, PM5, BP6 stay dormant + the
    UI can't surface "known classification" for the variants the field
    has already seen.
  - No real predictor scores → PP3, BP4 fall back to either curated
    demo values or zero.

Spec: https://docs.myvariant.info/en/latest/doc/data.html

Variant ID format used by myvariant.info: HGVS genomic notation, e.g.
  chr11:g.5226764C>T          (SNV)
  chr3:g.123_125del           (deletion)
  chr2:g.100_101insG          (insertion)
We emit only SNVs in the canonical case; indel HGVS encoding follows
the trimmed-allele convention from the input VCF.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Iterable, Optional

import httpx

from ..joint import JointVariant
from ..models import ClinVarRecord, PopulationAF, PredictorScores, Variant

log = logging.getLogger(__name__)

MYVARIANT_URL = "https://myvariant.info/v1/variant"
BATCH_SIZE = 200            # smaller batches → finer progress + faster recovery on a slow batch
# With shared-cpu-4x + 8 GB we can push to 10-way concurrent without memory
# pressure. myvariant.info handles this volume fine.
MAX_CONCURRENT = 10
PER_BATCH_TIMEOUT = 30.0    # seconds; one slow batch shouldn't stall the whole job
FIELDS = ",".join([
    # ClinVar
    "clinvar.rcv.clinical_significance",
    "clinvar.rcv.conditions",
    "clinvar.rcv.last_evaluated",
    "clinvar.rcv.review_status",
    "clinvar.rcv.accession",
    "clinvar.variant_id",
    # Gene-level (OMIM)
    "dbnsfp.genename",
    "dbnsfp.omim",
    "dbnsfp.gene.omim_id",
    # gnomAD AFs (global + per-population). myvariant.info exposes both
    # gnomad_exome and gnomad_genome; we take whichever is present per
    # variant, preferring the joint signal (exomes + genomes) — myvariant
    # publishes them separately so we union them downstream.
    "gnomad_exome.af.af",
    "gnomad_exome.af.af_sas",
    "gnomad_exome.ac.ac",
    "gnomad_exome.ac.ac_sas",
    "gnomad_exome.an.an",
    "gnomad_exome.an.an_sas",
    "gnomad_exome.hom",
    "gnomad_genome.af.af",
    "gnomad_genome.af.af_sas",
    "gnomad_genome.ac.ac",
    "gnomad_genome.ac.ac_sas",
    "gnomad_genome.an.an",
    "gnomad_genome.an.an_sas",
    "gnomad_genome.hom",
    # dbNSFP predictors — kept as a fairly broad set so the report has
    # multiple independent signals to triangulate on. dbNSFP exposes both
    # the raw score (native convention, low- or high-is-damaging varies)
    # and a converted_rankscore [0..1] high=damaging; we prefer the raw
    # score so the frontend can label each row with its native threshold.
    "dbnsfp.revel.score",
    "dbnsfp.cadd.phred",
    "dbnsfp.alphamissense.score",
    "dbnsfp.spliceai.dp_ag",
    "dbnsfp.spliceai.dp_al",
    "dbnsfp.spliceai.dp_dg",
    "dbnsfp.spliceai.dp_dl",
    "dbnsfp.spliceai.ds_ag",
    "dbnsfp.spliceai.ds_al",
    "dbnsfp.spliceai.ds_dg",
    "dbnsfp.spliceai.ds_dl",
    "dbnsfp.phylop.100way_vertebrate.rankscore",
    "dbnsfp.gerp",
    # Classic per-amino-acid predictors. SIFT (low=damaging) and PolyPhen2
    # (high=damaging) are the legacy pair; MutationTaster/LRT/FATHMM/PROVEAN
    # round out the conservation + structural-impact panel; MetaSVM /
    # MetaLR are ensemble meta-predictors that aggregate several of the
    # above into a single score.
    "dbnsfp.sift.score",
    "dbnsfp.polyphen2.hvar.score",
    "dbnsfp.polyphen2.hdiv.score",
    "dbnsfp.mutationtaster.score",
    "dbnsfp.lrt.score",
    "dbnsfp.fathmm.score",
    "dbnsfp.provean.score",
    "dbnsfp.metasvm.score",
    "dbnsfp.metalr.score",
    "dbnsfp.vest4.score",
])


def hgvs_id(jv: JointVariant) -> Optional[str]:
    """Encode a JointVariant as a myvariant.info-compatible HGVS string.

    Returns None for cases we can't encode cleanly (multi-allelic, ambiguous
    indel representation, etc.). The caller skips those variants.
    """
    chrom = jv.chrom if jv.chrom.startswith("chr") else f"chr{jv.chrom}"
    ref, alt = jv.ref, jv.alt
    if not ref or not alt or len(ref) > 100 or len(alt) > 100:
        return None
    # SNV: simplest case.
    if len(ref) == 1 and len(alt) == 1:
        return f"{chrom}:g.{jv.pos}{ref}>{alt}"
    # Insertion: ref=A, alt=AGGG → insGGG after pos
    if len(ref) == 1 and len(alt) > 1 and alt.startswith(ref):
        return f"{chrom}:g.{jv.pos}_{jv.pos + 1}ins{alt[1:]}"
    # Deletion: ref=AGGG, alt=A → del at pos+1..pos+len(ref)-1
    if len(alt) == 1 and len(ref) > 1 and ref.startswith(alt):
        start = jv.pos + 1
        end = jv.pos + len(ref) - 1
        return f"{chrom}:g.{start}_{end}del"
    # Multi-nucleotide substitution: delins
    return f"{chrom}:g.{jv.pos}_{jv.pos + len(ref) - 1}delins{alt}"


async def fetch_af_for_filtering_async(
    joints: Iterable[JointVariant],
    *,
    assembly: str = "hg38",
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict[tuple[str, int, str, str], float]:
    """Pre-annotation: ask myvariant.info for the max global AF per variant.

    Runs up to MAX_CONCURRENT batches in parallel via httpx.AsyncClient. Each
    batch is BATCH_SIZE (200) variants — small enough that one slow request
    only stalls 200 variants worth of progress. ~57 batches for a 114k-variant
    input × 10-way concurrency ≈ 6 round-trips wall time.

    The `progress` callback fires with (completed_batches, total_batches) after
    every finished batch so the caller can stream updates to the engine log.

    Returns (chrom, pos, ref, alt) → max_af. Variants myvariant.info doesn't
    know are absent from the map (callers treat as "unknown / probably rare").
    """
    joints_list = list(joints)
    if not joints_list:
        return {}
    by_id: dict[str, JointVariant] = {}
    for jv in joints_list:
        vid = hgvs_id(jv)
        if vid:
            by_id[vid] = jv
    if not by_id:
        return {}

    ids = list(by_id.keys())
    chunks = [ids[i:i + BATCH_SIZE] for i in range(0, len(ids), BATCH_SIZE)]
    total = len(chunks)
    out: dict[tuple[str, int, str, str], float] = {}
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    done = 0
    lock = asyncio.Lock()

    async with httpx.AsyncClient(
        timeout=PER_BATCH_TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def fetch_batch(chunk: list[str]) -> dict[tuple[str, int, str, str], float]:
            nonlocal done
            async with sem:
                try:
                    resp = await client.post(
                        MYVARIANT_URL,
                        data={
                            "ids": ",".join(chunk),
                            "fields": "gnomad_exome.af.af,gnomad_genome.af.af",
                            "assembly": assembly,
                        },
                    )
                    resp.raise_for_status()
                    results = resp.json()
                except (httpx.HTTPError, ValueError) as exc:
                    log.warning("myvariant.info filter batch failed: %s", exc)
                    async with lock:
                        done += 1
                        if progress:
                            progress(done, total)
                    return {}
            batch_out: dict[tuple[str, int, str, str], float] = {}
            if isinstance(results, list):
                for entry in results:
                    vid = entry.get("query") or entry.get("_id")
                    jv = by_id.get(vid)
                    if not jv:
                        continue
                    af = max(
                        _to_float(_nested(entry, "gnomad_exome", "af", "af")) or 0.0,
                        _to_float(_nested(entry, "gnomad_genome", "af", "af")) or 0.0,
                    )
                    if af > 0:
                        batch_out[jv.key] = af
            async with lock:
                done += 1
                if progress:
                    progress(done, total)
            return batch_out

        results = await asyncio.gather(*(fetch_batch(c) for c in chunks))
        for r in results:
            out.update(r)
    return out


def fetch_af_for_filtering(
    joints: Iterable[JointVariant],
    *,
    assembly: str = "hg38",
    progress: Optional[Callable[[int, int], None]] = None,
) -> dict[tuple[str, int, str, str], float]:
    """Synchronous wrapper around fetch_af_for_filtering_async — convenient when
    calling from sync code (tests, CLI). Engine pipelines should prefer the
    async version so they don't block the event loop on a fresh asyncio.run."""
    return asyncio.run(fetch_af_for_filtering_async(
        joints, assembly=assembly, progress=progress,
    ))


async def annotate_variants_async(
    pairs: Iterable[tuple[JointVariant, Variant]],
    *,
    assembly: str = "hg38",
    progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """Populate v.clinvar + v.predictors + v.populations for each pair, in place.

    Concurrent batches via httpx.AsyncClient + semaphore. The `progress`
    callback fires per finished batch so the caller can surface progress.
    """
    pairs_list = list(pairs)
    if not pairs_list:
        return 0
    by_id: dict[str, tuple[JointVariant, Variant]] = {}
    for jv, v in pairs_list:
        vid = hgvs_id(jv)
        if vid:
            by_id[vid] = (jv, v)
    if not by_id:
        return 0

    ids = list(by_id.keys())
    chunks = [ids[i:i + BATCH_SIZE] for i in range(0, len(ids), BATCH_SIZE)]
    total = len(chunks)
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    done = 0
    lock = asyncio.Lock()
    annotated = 0

    async with httpx.AsyncClient(
        timeout=PER_BATCH_TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def fetch_one(chunk: list[str]) -> int:
            nonlocal done
            async with sem:
                try:
                    resp = await client.post(
                        MYVARIANT_URL,
                        data={
                            "ids": ",".join(chunk),
                            "fields": FIELDS,
                            "assembly": assembly,
                        },
                    )
                    resp.raise_for_status()
                    results = resp.json()
                except (httpx.HTTPError, ValueError) as exc:
                    log.warning("myvariant.info annotate batch failed: %s", exc)
                    async with lock:
                        done += 1
                        if progress:
                            progress(done, total)
                    return 0
            local = 0
            if isinstance(results, list):
                for entry in results:
                    vid = entry.get("query") or entry.get("_id")
                    pair = by_id.get(vid)
                    if not pair:
                        continue
                    _, v = pair
                    # Wrap each projection: a malformed entry from myvariant.info
                    # (unexpected int where str expected, missing required fields,
                    # etc.) shouldn't take down the whole batch.
                    try:
                        cv = _project_clinvar(entry.get("clinvar"))
                    except Exception as e:  # noqa: BLE001
                        log.debug("clinvar projection failed for %s: %s", vid, e)
                        cv = None
                    if cv:
                        v.clinvar = cv
                        local += 1
                    try:
                        pops = _project_gnomad(entry.get("gnomad_exome"), entry.get("gnomad_genome"))
                    except Exception as e:  # noqa: BLE001
                        log.debug("gnomad projection failed for %s: %s", vid, e)
                        pops = []
                    if pops:
                        v.populations = pops
                        local += 1
                    # OMIM gene id (the *number) from dbnsfp.
                    dbnsfp = entry.get("dbnsfp") or {}
                    if isinstance(dbnsfp, dict) and not v.omim_id:
                        # myvariant returns dbnsfp.omim as a list of strings sometimes.
                        omim_v = dbnsfp.get("omim")
                        if isinstance(omim_v, list) and omim_v:
                            v.omim_id = str(omim_v[0])
                        elif isinstance(omim_v, (str, int)):
                            v.omim_id = str(omim_v)
                        else:
                            gene = dbnsfp.get("gene")
                            if isinstance(gene, dict):
                                go = gene.get("omim_id")
                                if go:
                                    v.omim_id = str(go)
                    try:
                        preds = _project_dbnsfp(entry.get("dbnsfp"))
                    except Exception as e:  # noqa: BLE001
                        log.debug("dbnsfp projection failed for %s: %s", vid, e)
                        preds = None
                    if preds:
                        v.predictors = _merge_predictors(v.predictors, preds)
                        local += 1
            async with lock:
                done += 1
                if progress:
                    progress(done, total)
            return local

        per_batch = await asyncio.gather(*(fetch_one(c) for c in chunks))
        annotated = sum(per_batch)
    return annotated


def annotate_variants(
    pairs: Iterable[tuple[JointVariant, Variant]],
    *,
    timeout: float = 30.0,
    assembly: str = "hg38",
) -> int:
    """Populate v.clinvar + v.predictors for each (JointVariant, Variant) pair.

    The pair structure lets us keep the indel-encoding logic on JointVariant
    (where chrom/pos/ref/alt live unmodified) while projecting onto the UI
    Variant model. Returns the count of variants that received any annotation.
    """
    pairs_list = list(pairs)
    if not pairs_list:
        return 0

    # Build the ID → variant map so we can match the response back.
    by_id: dict[str, tuple[JointVariant, Variant]] = {}
    for jv, v in pairs_list:
        vid = hgvs_id(jv)
        if vid:
            by_id[vid] = (jv, v)
    if not by_id:
        return 0

    annotated = 0
    ids = list(by_id.keys())
    with httpx.Client(timeout=timeout, headers={"User-Agent": "variantgpt-engine/0.1"}) as client:
        for i in range(0, len(ids), BATCH_SIZE):
            chunk = ids[i:i + BATCH_SIZE]
            try:
                resp = client.post(
                    MYVARIANT_URL,
                    data={
                        "ids": ",".join(chunk),
                        "fields": FIELDS,
                        "assembly": assembly,
                    },
                )
                resp.raise_for_status()
                results = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("myvariant.info batch %d failed: %s", i, exc)
                continue

            if not isinstance(results, list):
                continue
            for entry in results:
                vid = entry.get("query") or entry.get("_id")
                pair = by_id.get(vid)
                if not pair:
                    continue
                _, v = pair
                cv = _project_clinvar(entry.get("clinvar"))
                if cv:
                    v.clinvar = cv
                    annotated += 1
                pops = _project_gnomad(entry.get("gnomad_exome"), entry.get("gnomad_genome"))
                if pops:
                    # Replace populations from myvariant.info as authoritative —
                    # they're the canonical AF/AC/AN from the actual database, and
                    # we don't want to double-count against any partial AFs that
                    # leaked in earlier.
                    v.populations = pops
                    annotated += 1
                preds = _project_dbnsfp(entry.get("dbnsfp"))
                if preds:
                    # Merge — don't overwrite existing predictor scores from
                    # CSQ/demo overlay; fill in only where missing.
                    v.predictors = _merge_predictors(v.predictors, preds)
                    annotated += 1
    return annotated


# ────────────────────────── projection helpers ──────────────────────────

_REVIEW_STAR_MAP = {
    "practice guideline": 4,
    "reviewed by expert panel": 3,
    "criteria provided, multiple submitters, no conflicts": 2,
    "criteria provided, conflicting classifications": 1,
    "criteria provided, conflicting interpretations": 1,  # legacy alt phrasing
    "criteria provided, single submitter": 1,
    "no assertion criteria provided": 0,
    "no classification provided": 0,
    "no interpretation for the single variant": 0,
}


def _stars(review_status: Optional[str]) -> Optional[int]:
    if not review_status:
        return None
    return _REVIEW_STAR_MAP.get(review_status.lower())


def _project_clinvar(raw) -> Optional[ClinVarRecord]:
    if not raw or not isinstance(raw, dict):
        return None
    rcv = raw.get("rcv")
    # rcv can be a single dict or a list when multiple submissions exist.
    if isinstance(rcv, dict):
        rcv_list = [rcv]
    elif isinstance(rcv, list):
        rcv_list = [r for r in rcv if isinstance(r, dict)]
    else:
        rcv_list = []
    if not rcv_list:
        return None
    # Pick the highest-star RCV as the canonical record; aggregate conditions
    # across all.
    ranked = sorted(rcv_list, key=lambda r: -(_stars(r.get("review_status")) or 0))
    primary = ranked[0]
    conditions: list[str] = []
    for r in rcv_list:
        cond = r.get("conditions")
        if isinstance(cond, dict):
            name = cond.get("name")
            if name and name not in conditions:
                conditions.append(name)
        elif isinstance(cond, list):
            for c in cond:
                if isinstance(c, dict) and c.get("name") and c["name"] not in conditions:
                    conditions.append(c["name"])
    def _to_str(v) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v or None
        # myvariant.info sometimes returns variant_id as int (e.g. 729893).
        return str(v)

    def _to_str_or_none(v) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str):
            return v or None
        if isinstance(v, list):
            # Take the first string we can find.
            for item in v:
                s = _to_str_or_none(item)
                if s:
                    return s
            return None
        return str(v)

    return ClinVarRecord(
        rcv_count=len(rcv_list),
        clinical_significance=_to_str_or_none(primary.get("clinical_significance")),
        review_status=_to_str_or_none(primary.get("review_status")),
        review_stars=_stars(_to_str_or_none(primary.get("review_status"))),
        last_evaluated=_to_str_or_none(primary.get("last_evaluated")),
        conditions=[c for c in conditions[:5] if c],   # cap UI noise
        variation_id=_to_str(raw.get("variant_id")) or _to_str(primary.get("accession")),
    )


def _project_gnomad(exome: Optional[dict], genome: Optional[dict]) -> list[PopulationAF]:
    """Build PopulationAF rows from myvariant.info gnomad_exome/genome blocks.

    We emit gnomad_v4_global + gnomad_v4_sas — same source tags the rest of the
    pipeline expects (filter.py, reclassify.py). When both exome and genome
    cohorts report this variant we sum AC/AN to get the joint signal; when
    only one is present we use it alone.
    """
    if not exome and not genome:
        return []
    out: list[PopulationAF] = []
    # Combine global counts across exome+genome.
    e_ac = _to_float(_nested(exome, "ac", "ac")) or 0.0 if exome else 0.0
    e_an = _to_float(_nested(exome, "an", "an")) or 0.0 if exome else 0.0
    g_ac = _to_float(_nested(genome, "ac", "ac")) or 0.0 if genome else 0.0
    g_an = _to_float(_nested(genome, "an", "an")) or 0.0 if genome else 0.0
    total_ac = e_ac + g_ac
    total_an = e_an + g_an
    if total_an > 0:
        out.append(PopulationAF(
            source="gnomad_v4_global",
            ac=int(total_ac) if total_ac else None,
            an=int(total_an) if total_an else None,
            af=(total_ac / total_an) if total_an else None,
        ))
    else:
        # Fall back to whichever cohort has a precomputed AF.
        af_e = _to_float(_nested(exome, "af", "af")) if exome else None
        af_g = _to_float(_nested(genome, "af", "af")) if genome else None
        af = af_e if af_e is not None else af_g
        if af is not None:
            out.append(PopulationAF(source="gnomad_v4_global", af=af))

    # SAS-specific counts. Same exome+genome combine.
    e_ac_sas = _to_float(_nested(exome, "ac", "ac_sas")) or 0.0 if exome else 0.0
    e_an_sas = _to_float(_nested(exome, "an", "an_sas")) or 0.0 if exome else 0.0
    g_ac_sas = _to_float(_nested(genome, "ac", "ac_sas")) or 0.0 if genome else 0.0
    g_an_sas = _to_float(_nested(genome, "an", "an_sas")) or 0.0 if genome else 0.0
    total_ac_sas = e_ac_sas + g_ac_sas
    total_an_sas = e_an_sas + g_an_sas
    if total_an_sas > 0:
        out.append(PopulationAF(
            source="gnomad_v4_sas",
            ac=int(total_ac_sas) if total_ac_sas else None,
            an=int(total_an_sas) if total_an_sas else None,
            af=(total_ac_sas / total_an_sas) if total_an_sas else None,
        ))
    return out


def _project_dbnsfp(raw) -> Optional[PredictorScores]:
    if not raw or not isinstance(raw, dict):
        return None
    revel = _nested(raw, "revel", "score")
    cadd = _nested(raw, "cadd", "phred")
    alphamissense = _nested(raw, "alphamissense", "score")
    # SpliceAI delta scores: take the max across (acceptor_gain, acceptor_loss,
    # donor_gain, donor_loss) per Jaganathan 2019 / ClinGen RNA SVI guidance.
    spliceai = _max_of(
        _nested(raw, "spliceai", "ds_ag"),
        _nested(raw, "spliceai", "ds_al"),
        _nested(raw, "spliceai", "ds_dg"),
        _nested(raw, "spliceai", "ds_dl"),
    )
    phylop = _nested(raw, "phylop", "100way_vertebrate", "rankscore")
    gerp_raw = raw.get("gerp")
    gerp = gerp_raw.get("nr") if isinstance(gerp_raw, dict) else None

    # Classic per-residue predictors. dbNSFP returns these per-transcript;
    # _to_float() takes the max across the list. SIFT is the exception —
    # SIFT convention is LOW = damaging, so taking max is intentionally
    # the *most benign* score across transcripts. Frontend renders the raw
    # number with the directionality cue.
    sift = _nested(raw, "sift", "score")
    polyphen2_hvar = _nested(raw, "polyphen2", "hvar", "score")
    polyphen2_hdiv = _nested(raw, "polyphen2", "hdiv", "score")
    mutation_taster = _nested(raw, "mutationtaster", "score")
    lrt = _nested(raw, "lrt", "score")
    fathmm = _nested(raw, "fathmm", "score")
    provean = _nested(raw, "provean", "score")
    metasvm = _nested(raw, "metasvm", "score")
    metalr = _nested(raw, "metalr", "score")
    vest4 = _nested(raw, "vest4", "score")

    return PredictorScores(
        alphamissense=_to_float(alphamissense),
        revel=_to_float(revel),
        cadd=_to_float(cadd),
        spliceai=_to_float(spliceai),
        phylop=_to_float(phylop),
        gerp=_to_float(gerp),
        sift_score=_to_float_min(sift),       # SIFT: take min (most damaging) across transcripts
        polyphen2_hvar=_to_float(polyphen2_hvar),
        polyphen2_hdiv=_to_float(polyphen2_hdiv),
        mutation_taster=_to_float(mutation_taster),
        lrt=_to_float(lrt),
        fathmm=_to_float_min(fathmm),         # FATHMM: low = damaging, take min
        provean=_to_float_min(provean),       # PROVEAN: low = damaging, take min
        metasvm=_to_float(metasvm),
        metalr=_to_float(metalr),
        vest4=_to_float(vest4),
    )


def _merge_predictors(cur: PredictorScores, new: PredictorScores) -> PredictorScores:
    """Fill in missing fields on `cur` from `new`. Existing non-None values
    on `cur` are preserved (don't overwrite scores already set by VEP/CSQ
    or a curated demo overlay). Returns a new PredictorScores."""
    return PredictorScores(
        **{
            k: (getattr(cur, k) if getattr(cur, k) is not None else getattr(new, k))
            for k in PredictorScores.model_fields.keys()
        }
    )


def _to_float_min(v) -> Optional[float]:
    """Variant of _to_float that returns the MIN across a transcript list.
    Used for SIFT / FATHMM / PROVEAN where low = damaging — we want the
    most damaging score, not the most benign, when picking one to report."""
    if v is None:
        return None
    if isinstance(v, list):
        flat = [x for x in v if isinstance(x, (int, float))]
        return min(flat) if flat else None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _nested(d, *keys):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _to_float(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, list):
        # myvariant.info sometimes returns lists for fields that have multiple
        # transcript-level scores; take the max.
        flat = [x for x in v if isinstance(x, (int, float))]
        return max(flat) if flat else None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _max_of(*vals) -> Optional[float]:
    floats = [_to_float(v) for v in vals]
    floats = [f for f in floats if f is not None]
    return max(floats) if floats else None
