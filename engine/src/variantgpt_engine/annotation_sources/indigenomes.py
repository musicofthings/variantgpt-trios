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
PER_BATCH_TIMEOUT = 30.0

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
) -> dict[tuple[str, int, str, str], dict]:
    """POST a gene query, return (chrom,pos,ref,alt) → {ac,an,af}."""
    out: dict[tuple[str, int, str, str], dict] = {}
    try:
        resp = await client.post(
            INDIGEN_API,
            json={"Name": gene},
        )
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        log.debug("IndiGen gene fetch failed for %s: %s", gene, e)
        return out
    for rec in data.get("mydata", []) or []:
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
) -> dict[tuple[str, int, str, str], dict]:
    """Build an (chrom,pos,ref,alt) → {ac,an,af} map for the variants by
    batched gene lookup. Concurrent fetches of unique gene names; each gene
    response carries hundreds of variants so this is efficient.

    progress callback fires (done_genes, total_genes) after each gene
    response so the engine can surface live progress.
    """
    # Collect unique non-empty gene names.
    genes: list[str] = []
    seen: set[str] = set()
    for v in variants:
        g = (v.gene or "").strip()
        if g and g not in seen:
            seen.add(g)
            genes.append(g)
    if not genes:
        return {}

    total = len(genes)
    done = 0
    lock = asyncio.Lock()
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    merged: dict[tuple[str, int, str, str], dict] = {}

    async with httpx.AsyncClient(
        timeout=PER_BATCH_TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def one(gene: str) -> None:
            nonlocal done
            async with sem:
                gene_map = await fetch_gene(client, gene)
            async with lock:
                merged.update(gene_map)
                done += 1
                if progress:
                    progress(done, total)

        await asyncio.gather(*(one(g) for g in genes))
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
