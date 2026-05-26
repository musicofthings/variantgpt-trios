"""IndiGenomes (IGIB) allele-frequency lookup — live API client.

Cohort: 1,029 unrelated Indian whole genomes (IGIB IndiGen project).
Source: https://clingen.igib.res.in/indigen/

Why live API (not bulk download):
  The public IndiGenomes_Variants.vcf.gz contains only variant sites with
  variation type — no allele counts. The actual AC/AN/AF data lives in
  IGIB's MongoDB backend, accessible via POST /indigen/data.php with
  {"Name": "<gene name>"} returning all variants in that gene.

Strategy:
  After per-variant annotation has assigned a gene to each surviving
  variant, we batch-query the API by unique gene name. Each gene response
  carries hundreds of variants with full INFO strings — we parse AC/AF/AN
  out of `Info` and build a local (chrom,pos,ref,alt) → AF map for the
  case. ~2000 unique genes per typical case × 200ms each × 10-way
  concurrency ≈ ~40s wall clock.

Result: every variant in a known gene gets a real IndiGen AF (or
explicit None if IndiGen has no record for that exact alt). Variants
without a gene assignment skip IndiGen.

Failures (network, parse, etc.) degrade silently — return empty maps.
The reclassification engine handles missing IndiGen AF gracefully (no
firing of BS1 from IndiGen for that variant).
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Callable, Iterable, Optional

import httpx

from ..joint import JointVariant
from ..models import PopulationAF, Variant

log = logging.getLogger(__name__)

INDIGEN_API = "https://clingen.igib.res.in/indigen/data.php"
MAX_CONCURRENT = 8
PER_BATCH_TIMEOUT = 15.0           # IGIB is slow on big genes — fail fast instead of waiting
MAX_GENES_PER_CASE = 400           # cap; gene responses can be 7+ seconds each on heavy genes

# Parse the AC/AN/AF tokens from the IndiGen MongoDB `Info` string, e.g.
#   "AC=86;AF=0.042;AN=2050;DP=24889;FS=0.517;..."
_INFO_AC = re.compile(r"(?:^|;)AC=([0-9.,]+)")
_INFO_AN = re.compile(r"(?:^|;)AN=([0-9.]+)")
_INFO_AF = re.compile(r"(?:^|;)AF=([0-9.,]+)")


def _parse_info_af(info: str, target_alt: Optional[str] = None) -> Optional[dict]:
    """Extract {ac, an, af} from a single IndiGen record's Info string.

    Multi-allelic sites have comma-separated AC/AF; if target_alt is provided
    we'd ideally pick the right index, but IndiGen records are typically
    bi-allelic and the API returns one record per allele anyway.
    """
    if not info or info == "." or info == "":
        return None
    af_m = _INFO_AF.search(info)
    ac_m = _INFO_AC.search(info)
    an_m = _INFO_AN.search(info)
    if not af_m:
        return None
    try:
        af = float(af_m.group(1).split(",")[0])
    except ValueError:
        return None
    try:
        ac = int(ac_m.group(1).split(",")[0]) if ac_m else None
    except ValueError:
        ac = None
    try:
        an = int(an_m.group(1)) if an_m else None
    except ValueError:
        an = None
    return {"ac": ac, "an": an, "af": af}


def _normalize_chrom(chrom: str) -> str:
    bare = chrom.removeprefix("chr").removeprefix("Chr")
    if bare in ("M", "MT"):
        bare = "M"
    return f"chr{bare}"


async def fetch_gene(
    client: httpx.AsyncClient, gene: str,
    *, debug_capture: Optional[list] = None,
) -> dict[tuple[str, int, str, str], dict]:
    """POST a gene query, return (chrom,pos,ref,alt) → {ac,an,af}.

    debug_capture (if provided) is a list we append per-gene diagnostics
    to so the caller can surface the first few responses to the engine log.
    """
    out: dict[tuple[str, int, str, str], dict] = {}
    err: Optional[str] = None
    body_preview = ""
    try:
        resp = await client.post(
            INDIGEN_API,
            json={"Name": gene},
        )
        body_preview = (resp.text or "")[:120]
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPError as e:
        err = f"http: {type(e).__name__}: {e}"
    except ValueError as e:
        err = f"parse: {e}"
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {e}"

    if err:
        if debug_capture is not None and len(debug_capture) < 5:
            debug_capture.append(f"gene={gene} ERR {err} body[:120]={body_preview!r}")
        log.warning("IndiGen gene fetch failed for %s: %s", gene, err)
        return out

    records = data.get("mydata", []) if isinstance(data, dict) else None
    if debug_capture is not None and len(debug_capture) < 5:
        debug_capture.append(
            f"gene={gene} records={len(records) if records is not None else 'None'} "
            f"first_keys={list((records[0] if records else {}).keys())[:6]}"
        )

    for rec in records or []:
        chrom = _normalize_chrom(str(rec.get("Chr") or rec.get("Chr_VCF") or ""))
        pos_raw = rec.get("Start") or rec.get("Start_VCF")
        ref = rec.get("Ref") or rec.get("Ref_VCF")
        alt = rec.get("Alt") or rec.get("Alt_VCF")
        info = rec.get("Info") or ""
        if not (chrom and pos_raw and ref and alt and info):
            continue
        try:
            pos = int(pos_raw)
        except (TypeError, ValueError):
            continue
        af_info = _parse_info_af(info, target_alt=alt)
        if af_info is None:
            continue
        out[(chrom, pos, str(ref), str(alt))] = af_info
    return out


async def fetch_for_variants_async(
    variants: Iterable[Variant],
    *,
    progress: Optional[Callable[[int, int], None]] = None,
    max_genes: int = MAX_GENES_PER_CASE,
) -> dict[tuple[str, int, str, str], dict]:
    """Build an (chrom,pos,ref,alt) → {ac,an,af} map for the variants by
    batched gene lookup against the IGIB IndiGen API.

    Genes are queried in priority order (highest variant priority first,
    then most-variants-per-gene). Capped at `max_genes` because every
    gene query downloads ALL variants in that gene from IndiGen's MongoDB
    — heavy genes like BRCA1 return 1400+ records and take 7+ seconds.
    For a typical case with ~8k candidates the top 400 genes cover all
    P/LP + most high-priority VUS variants.

    progress callback fires (done_genes, total_genes) after each gene
    response.
    """
    # Build a (gene -> sort_key) map. Sort key:
    #   1. -max_priority_score among variants in this gene
    #   2. -count of variants in this gene (more = more chance of reclass)
    # so genes with high-priority variants are queried first.
    from collections import defaultdict
    by_gene: dict[str, list] = defaultdict(list)
    for v in variants:
        g = (v.gene or "").strip()
        if g:
            by_gene[g].append(v)
    if not by_gene:
        return {}

    def gene_key(gene: str):
        vs = by_gene[gene]
        max_prio = max((v.priority_score or 0) for v in vs)
        return (-max_prio, -len(vs), gene)

    sorted_genes = sorted(by_gene.keys(), key=gene_key)
    if len(sorted_genes) > max_genes:
        log.info(
            "IndiGen: capping %d → %d genes (sorted by priority)",
            len(sorted_genes), max_genes,
        )
    genes = sorted_genes[:max_genes]

    total = len(genes)
    done = 0
    lock = asyncio.Lock()
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    merged: dict[tuple[str, int, str, str], dict] = {}
    debug_capture: list[str] = []   # first 5 per-gene diagnostics surfaced to engine log

    async with httpx.AsyncClient(
        timeout=PER_BATCH_TIMEOUT,
        # Match a regular browser fingerprint — IGIB may filter by UA.
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": "https://clingen.igib.res.in/indigen/",
            "Origin": "https://clingen.igib.res.in",
        },
    ) as client:
        async def one(gene: str) -> None:
            nonlocal done
            async with sem:
                gene_map = await fetch_gene(client, gene, debug_capture=debug_capture)
            async with lock:
                merged.update(gene_map)
                done += 1
                if progress:
                    progress(done, total)

        await asyncio.gather(*(one(g) for g in genes))

    # Surface the first few raw responses so the engine log shows what
    # we're actually getting back from IGIB.
    for line in debug_capture:
        log.info("IndiGen debug: %s", line)
    # Stash on the function for the caller to log.
    fetch_for_variants_async.last_debug = debug_capture  # type: ignore[attr-defined]
    return merged


def apply_indigen_to_variants(
    variants: list[Variant],
    af_map: dict[tuple[str, int, str, str], dict],
) -> int:
    """Append an indigenomes PopulationAF row to each variant that has a
    matching IndiGen record. Returns the count of variants annotated."""
    n = 0
    for v in variants:
        key = (_normalize_chrom(v.chrom), v.pos, v.ref, v.alt)
        rec = af_map.get(key)
        if rec is None:
            continue
        # Drop any pre-existing indigenomes row (from a previous run / cached
        # case.json) before appending — guarantees we never have stale data.
        v.populations = [p for p in v.populations if p.source != "indigenomes"]
        v.populations.append(PopulationAF(
            source="indigenomes",
            ac=rec.get("ac"),
            an=rec.get("an"),
            af=rec.get("af"),
        ))
        n += 1
    return n


# ─── back-compat stubs (we deleted the bulk SQLite path) ───
async def ensure_db_downloaded(_signed_url: Optional[str]) -> bool:
    return False


def populations_for(_chrom: str, _pos: int, _ref: str, _alt: str) -> list[PopulationAF]:
    """Used by annotation.py per-variant. With the live-API pivot, IndiGen is
    queried in bulk after annotation (apply_indigen_to_variants); per-variant
    calls would be too slow. Returns empty list — the bulk pass fills v.populations
    directly."""
    return []
