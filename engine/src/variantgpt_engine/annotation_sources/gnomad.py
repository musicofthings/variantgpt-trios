"""gnomAD v4 GraphQL adapter (PRD §4.4, §6.7).

Fetches per-ancestry AF — global (joint) and `sas` specifically — from the
public gnomAD GraphQL endpoint. Returns PopulationAF rows; ancestry filtering
happens client-side because gnomAD's GraphQL exposes per-population counts in
the same payload.

Notes:
  - The endpoint expects HGVS-style variantId: `1-55051215-G-A` (no `chr`).
  - We always request `dataset: gnomad_r4` (genomes + exomes joined).
  - On any network/parse failure we return an empty list so the pipeline
    degrades gracefully (matches the "deterministic result always renders"
    contract in PRD §6.7).
"""
from __future__ import annotations

import logging
from typing import Iterable, Optional

import httpx

from ..models import PopulationAF

log = logging.getLogger(__name__)

GNOMAD_URL = "https://gnomad.broadinstitute.org/api"
DATASET = "gnomad_r4"

_QUERY = """
query VariantAF($variantId: String!, $datasetId: DatasetId!) {
  variant(variantId: $variantId, dataset: $datasetId) {
    variantId
    joint {
      ac
      an
      af
      populations { id ac an }
    }
  }
}
"""


def _variant_id(chrom: str, pos: int, ref: str, alt: str) -> str:
    c = chrom.lower().removeprefix("chr")
    return f"{c}-{pos}-{ref}-{alt}"


def lookup(
    chrom: str, pos: int, ref: str, alt: str,
    *, timeout: float = 5.0, client: Optional[httpx.Client] = None,
) -> list[PopulationAF]:
    """Return [PopulationAF(global), PopulationAF(sas)] (only populated rows)."""
    vid = _variant_id(chrom, pos, ref, alt)
    owns_client = client is None
    client = client or httpx.Client(timeout=timeout, headers={"User-Agent": "variantgpt-engine/0.1"})
    try:
        resp = client.post(
            GNOMAD_URL,
            json={"query": _QUERY, "variables": {"variantId": vid, "datasetId": DATASET}},
        )
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("gnomAD lookup failed for %s: %s", vid, exc)
        return []
    finally:
        if owns_client:
            client.close()

    variant = (payload.get("data") or {}).get("variant")
    if not variant or not variant.get("joint"):
        return []
    joint = variant["joint"]
    out: list[PopulationAF] = [
        PopulationAF(
            source="gnomad_v4_global",
            ac=joint.get("ac"), an=joint.get("an"), af=joint.get("af"),
        ),
    ]
    for pop in joint.get("populations") or []:
        if pop.get("id") == "sas":
            an = pop.get("an") or 0
            ac = pop.get("ac") or 0
            out.append(PopulationAF(
                source="gnomad_v4_sas",
                ac=ac, an=an,
                af=(ac / an) if an else None,
            ))
            break
    return out


def lookup_batch(
    variants: Iterable[tuple[str, int, str, str]],
    *, timeout: float = 5.0,
) -> dict[tuple[str, int, str, str], list[PopulationAF]]:
    """Sequential batch — gnomAD GraphQL has per-request rate limits; the Worker
    layer caches results via the AI Gateway HTTP cache. Persist beyond the
    engine run by writing into the populations table."""
    out: dict[tuple[str, int, str, str], list[PopulationAF]] = {}
    with httpx.Client(timeout=timeout, headers={"User-Agent": "variantgpt-engine/0.1"}) as client:
        for v in variants:
            out[v] = lookup(*v, client=client)
    return out
