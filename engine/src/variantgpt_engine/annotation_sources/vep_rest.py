"""Ensembl VEP REST API adapter — annotation fallback for variants that
arrived without CSQ.

Why this exists: hosting the official VEP cache needs ~25 GB on disk, more
than the Fly free-tier volume. The public REST API is free and stable enough
for clinical-scale candidate sets (after the rare-variant filter the input
is typically <10k rows). We batch up to 200 variants per request as the
endpoint accepts.

Rate limits (Ensembl public REST):
  - 15 requests/sec sustained, 55 requests/sec burst
  - 1000 requests/hour for anonymous use; auth not required for this volume
  - We sleep 100ms between batches as a courtesy

On any failure we return an empty dict so the pipeline degrades to the
demo-data lookup / "no annotation" rendering — never a hard failure.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable, Iterable, Optional

import httpx

from ..joint import JointVariant

log = logging.getLogger(__name__)

VEP_URL = "https://rest.ensembl.org/vep/human/region"
BATCH_SIZE = 200
MAX_CONCURRENT = 4        # Ensembl REST recommends staying ≤15 req/sec; 4-way concurrent stays safely under
PER_BATCH_TIMEOUT = 60.0  # Ensembl can be slow on 200-variant payloads


async def annotate_batch_async(
    joint: Iterable[JointVariant],
    *,
    only_missing_csq: bool = True,
    progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """Populate jv.csq in-place for variants that lack it.

    Concurrent VEP REST batches via httpx.AsyncClient + semaphore. Each batch
    is 200 variants; up to MAX_CONCURRENT batches run in parallel. The
    `progress` callback fires with (done_batches, total_batches) after each
    batch so the caller can surface per-batch movement to the engine log.

    Returns the count of variants that received fresh annotation.
    """
    targets: list[JointVariant] = [
        jv for jv in joint
        if (not only_missing_csq or not jv.csq)
    ]
    if not targets:
        return 0

    chunks = [targets[i:i + BATCH_SIZE] for i in range(0, len(targets), BATCH_SIZE)]
    total = len(chunks)
    sem = asyncio.Semaphore(MAX_CONCURRENT)
    done = 0
    lock = asyncio.Lock()
    filled_count = 0

    async with httpx.AsyncClient(
        timeout=PER_BATCH_TIMEOUT,
        headers={"User-Agent": "variantgpt-engine/0.1"},
    ) as client:
        async def fetch_batch(chunk: list[JointVariant]) -> int:
            nonlocal done
            async with sem:
                payload = {"variants": [_vep_region(jv) for jv in chunk]}
                try:
                    resp = await client.post(
                        VEP_URL,
                        headers={"content-type": "application/json", "accept": "application/json"},
                        json=payload,
                    )
                    resp.raise_for_status()
                    results = resp.json()
                except (httpx.HTTPError, ValueError) as exc:
                    log.warning("VEP REST batch failed: %s", exc)
                    async with lock:
                        done += 1
                        if progress:
                            progress(done, total)
                    return 0
            local_filled = 0
            if isinstance(results, list):
                by_input = {r.get("input"): r for r in results if isinstance(r, dict)}
                for jv in chunk:
                    vep = by_input.get(_vep_region(jv))
                    if not vep:
                        continue
                    jv.csq = _project(vep)
                    if jv.csq:
                        local_filled += 1
            async with lock:
                done += 1
                if progress:
                    progress(done, total)
            return local_filled

        per_batch = await asyncio.gather(*(fetch_batch(c) for c in chunks))
        filled_count = sum(per_batch)
    return filled_count


def annotate_batch(
    joint: Iterable[JointVariant],
    *,
    only_missing_csq: bool = True,
    progress: Optional[Callable[[int, int], None]] = None,
) -> int:
    """Sync wrapper around annotate_batch_async — convenient for tests/CLI."""
    return asyncio.run(annotate_batch_async(
        joint, only_missing_csq=only_missing_csq, progress=progress,
    ))


def _vep_region(jv: JointVariant) -> str:
    """Ensembl region notation: '1 55051215 . G A . . .' (space-separated VCF-like).
    The trailing '.'s are placeholders for ID/QUAL/FILTER."""
    chrom = jv.chrom.removeprefix("chr")
    return f"{chrom} {jv.pos} . {jv.ref} {jv.alt} . . ."


def _project(vep_entry: dict) -> list[dict[str, str]]:
    """Convert one VEP REST response into our CSQ-shaped list of dicts.

    REST gives us transcript_consequences with normalized keys; we map them
    to the standard VEP plugin field names that csq.pick_canonical expects.
    """
    out: list[dict[str, str]] = []
    for tc in vep_entry.get("transcript_consequences") or []:
        cons = ",".join(tc.get("consequence_terms") or [])
        out.append({
            "Allele": vep_entry.get("allele_string", "").split("/")[-1],
            "Consequence": cons,
            "IMPACT": tc.get("impact", "") or "",
            "SYMBOL": tc.get("gene_symbol", "") or "",
            "Gene": tc.get("gene_id", "") or "",
            "Feature": tc.get("transcript_id", "") or "",
            "HGVSc": tc.get("hgvsc", "") or "",
            "HGVSp": tc.get("hgvsp", "") or "",
            "CANONICAL": "YES" if tc.get("canonical") else "",
            "MANE_SELECT": tc.get("mane_select", "") or "",
        })
    return out
