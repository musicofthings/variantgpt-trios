"""mygene.info gene-level metadata lookup.

Batched lookup of gene symbol → OMIM ID + gene name + NCBI Entrez summary
+ type-of-gene. Used to populate Variant.omim_id AND CaseEmission.gene_info
so the report and clinical drawer can show a "what does this gene do"
paragraph.

Free, no auth, by the same team as myvariant.info. Generous rate limits
on POSTs to /v3/query (we use up to 500 symbols per batch).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Iterable

import httpx

from ..models import GeneInfo

log = logging.getLogger(__name__)

MYGENE_QUERY = "https://mygene.info/v3/query"
BATCH_SIZE = 500
MAX_CONCURRENT = 4
TIMEOUT = 30.0


async def fetch_omim_for_symbols(symbols: Iterable[str]) -> dict[str, str]:
    """Return {gene_symbol: omim_id} for as many of the input symbols as
    mygene.info can resolve. Missing genes are absent from the result.

    Uses the /query endpoint with a multi-term q= so mygene can match each
    symbol against its index (the /gene/<id> endpoint only takes Entrez IDs).
    """
    syms = [s.strip() for s in symbols if s and s.strip()]
    unique = list({s for s in syms})
    if not unique:
        return {}

    out: dict[str, str] = {}
    chunks = [unique[i:i + BATCH_SIZE] for i in range(0, len(unique), BATCH_SIZE)]
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async with httpx.AsyncClient(
        timeout=TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def fetch_chunk(chunk: list[str]) -> dict[str, str]:
            async with sem:
                # Build a Lucene OR query of `symbol:SYM` terms. mygene treats
                # symbol as a field-qualified term.
                q = " OR ".join(f"symbol:{s}" for s in chunk)
                try:
                    resp = await client.post(
                        MYGENE_QUERY,
                        data={
                            "q": q,
                            "species": "human",
                            "fields": "symbol,MIM",
                            "size": str(len(chunk) * 2),  # allow multi-hit per symbol
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.HTTPError, ValueError) as e:
                    log.warning("mygene chunk failed: %s", e)
                    return {}
            chunk_out: dict[str, str] = {}
            for hit in data.get("hits", []):
                sym = hit.get("symbol")
                mim = hit.get("MIM")
                if not sym or not mim:
                    continue
                if isinstance(mim, list):
                    mim = mim[0] if mim else None
                if mim:
                    # First hit wins (mygene returns by relevance score).
                    chunk_out.setdefault(str(sym), str(mim))
            return chunk_out

        results = await asyncio.gather(*(fetch_chunk(c) for c in chunks))
        for r in results:
            out.update(r)
    return out


def apply_omim_to_variants(variants: list, omim_map: dict[str, str]) -> int:
    """Set v.omim_id from omim_map[v.gene] where present. Returns count
    of variants that got an OMIM id."""
    n = 0
    for v in variants:
        if v.omim_id:
            continue
        if v.gene and v.gene in omim_map:
            v.omim_id = omim_map[v.gene]
            n += 1
    return n


async def fetch_gene_info_for_symbols(symbols: Iterable[str]) -> dict[str, GeneInfo]:
    """Fetch GeneInfo (name, summary, OMIM, type) for each gene symbol.

    Same batched /query approach as fetch_omim_for_symbols but pulls the
    richer fields the report needs: gene full name, NCBI Entrez gene
    summary (a paragraph describing function), and type of gene.

    Returns {symbol: GeneInfo}. Genes mygene.info doesn't know are absent
    from the map (caller renders a fallback paragraph from structured
    data — see Report.tsx geneParagraph()).
    """
    syms = [s.strip() for s in symbols if s and s.strip()]
    unique = list({s for s in syms})
    if not unique:
        return {}

    out: dict[str, GeneInfo] = {}
    chunks = [unique[i:i + BATCH_SIZE] for i in range(0, len(unique), BATCH_SIZE)]
    sem = asyncio.Semaphore(MAX_CONCURRENT)

    async with httpx.AsyncClient(
        timeout=TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def fetch_chunk(chunk: list[str]) -> dict[str, GeneInfo]:
            async with sem:
                q = " OR ".join(f"symbol:{s}" for s in chunk)
                try:
                    resp = await client.post(
                        MYGENE_QUERY,
                        data={
                            "q": q,
                            "species": "human",
                            # mygene field reference:
                            #   name           – gene full name ("trio Rho guanine ...")
                            #   summary        – NCBI Entrez paragraph
                            #   type_of_gene   – protein-coding / ncRNA / pseudo / etc.
                            #   MIM            – OMIM gene id
                            "fields": "symbol,name,summary,type_of_gene,MIM",
                            "size": str(len(chunk) * 2),
                        },
                    )
                    resp.raise_for_status()
                    data = resp.json()
                except (httpx.HTTPError, ValueError) as e:
                    log.warning("mygene gene_info chunk failed: %s", e)
                    return {}
            chunk_out: dict[str, GeneInfo] = {}
            for hit in data.get("hits", []):
                sym = hit.get("symbol")
                if not sym or sym in chunk_out:
                    continue   # mygene returns by relevance; first wins
                mim = hit.get("MIM")
                if isinstance(mim, list):
                    mim = mim[0] if mim else None
                chunk_out[str(sym)] = GeneInfo(
                    symbol=str(sym),
                    name=_str_or_none(hit.get("name")),
                    summary=_str_or_none(hit.get("summary")),
                    type_of_gene=_str_or_none(hit.get("type_of_gene")),
                    omim_id=str(mim) if mim else None,
                )
            return chunk_out

        results = await asyncio.gather(*(fetch_chunk(c) for c in chunks))
        for r in results:
            out.update(r)
    return out


def _str_or_none(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v.strip() or None
    return str(v)
