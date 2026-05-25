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

import logging
import time
from typing import Iterable

import httpx

from ..joint import JointVariant

log = logging.getLogger(__name__)

VEP_URL = "https://rest.ensembl.org/vep/human/region"
BATCH_SIZE = 200
SLEEP_SEC = 0.1


def annotate_batch(
    joint: Iterable[JointVariant],
    *,
    timeout: float = 30.0,
    only_missing_csq: bool = True,
) -> int:
    """Populate jv.csq in-place for variants that lack it. Returns the count
    of variants that received fresh annotation.

    Each VEP REST response carries one entry per transcript_consequence; we
    project them onto our CSQ schema so downstream code (csq.apply_csq,
    filter.filter_candidates) keeps working unchanged.
    """
    targets: list[JointVariant] = [
        jv for jv in joint
        if (not only_missing_csq or not jv.csq)
    ]
    if not targets:
        return 0

    filled = 0
    with httpx.Client(timeout=timeout, headers={"User-Agent": "variantgpt-engine/0.1"}) as client:
        for i in range(0, len(targets), BATCH_SIZE):
            chunk = targets[i:i + BATCH_SIZE]
            payload = {"variants": [_vep_region(jv) for jv in chunk]}
            try:
                resp = client.post(
                    VEP_URL,
                    headers={"content-type": "application/json", "accept": "application/json"},
                    json=payload,
                )
                resp.raise_for_status()
                results = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("VEP REST batch %d-%d failed: %s", i, i + len(chunk), exc)
                continue

            # Match results back to inputs by 'input' string (region notation).
            by_input = {r.get("input"): r for r in results if isinstance(r, dict)}
            for jv in chunk:
                vep = by_input.get(_vep_region(jv))
                if not vep:
                    continue
                jv.csq = _project(vep)
                if jv.csq:
                    filled += 1

            time.sleep(SLEEP_SEC)
    return filled


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
