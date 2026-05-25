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

import logging
from typing import Iterable, Optional

import httpx

from ..joint import JointVariant
from ..models import ClinVarRecord, PredictorScores, Variant

log = logging.getLogger(__name__)

MYVARIANT_URL = "https://myvariant.info/v1/variant"
BATCH_SIZE = 1000           # myvariant.info limit
FIELDS = ",".join([
    # ClinVar
    "clinvar.rcv.clinical_significance",
    "clinvar.rcv.conditions",
    "clinvar.rcv.last_evaluated",
    "clinvar.rcv.review_status",
    "clinvar.rcv.accession",
    "clinvar.variant_id",
    # dbNSFP predictors
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
                preds = _project_dbnsfp(entry.get("dbnsfp"))
                if preds:
                    # Merge — don't overwrite existing predictor scores from
                    # CSQ/demo overlay; fill in only where missing.
                    cur = v.predictors
                    merged = PredictorScores(
                        alphamissense=cur.alphamissense if cur.alphamissense is not None else preds.alphamissense,
                        revel=cur.revel if cur.revel is not None else preds.revel,
                        cadd=cur.cadd if cur.cadd is not None else preds.cadd,
                        spliceai=cur.spliceai if cur.spliceai is not None else preds.spliceai,
                        phylop=cur.phylop if cur.phylop is not None else preds.phylop,
                        gerp=cur.gerp if cur.gerp is not None else preds.gerp,
                    )
                    v.predictors = merged
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
    return ClinVarRecord(
        rcv_count=len(rcv_list),
        clinical_significance=primary.get("clinical_significance"),
        review_status=primary.get("review_status"),
        review_stars=_stars(primary.get("review_status")),
        last_evaluated=primary.get("last_evaluated"),
        conditions=conditions[:5],          # cap UI noise
        variation_id=raw.get("variant_id") or primary.get("accession"),
    )


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
    return PredictorScores(
        alphamissense=_to_float(alphamissense),
        revel=_to_float(revel),
        cadd=_to_float(cadd),
        spliceai=_to_float(spliceai),
        phylop=_to_float(phylop),
        gerp=_to_float(gerp),
    )


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
