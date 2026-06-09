"""gnomAD v4 GraphQL adapter (PRD §4.4, §6.7).

Fetches per-ancestry AF — global (joint = exomes + genomes when available, else
exome alone) and the `sas` (South Asian) slice — from the public gnomAD GraphQL.

Schema notes (verified against gnomad.broadinstitute.org/api Nov 2025):
  - variantId is `1-55051215-G-A` (no `chr`), dataset is `gnomad_r4`.
  - Response field names are snake_case: `variant_id`, not `variantId`.
  - `joint` exposes ac/an + per-population ac/an, but NO precomputed `af` —
    we compute it client-side as ac/an. The old query asked for `joint { af }`
    which is why every call was 400-ing.
  - Population IDs include `sas`, `nfe`, `eas`, `afr`, `amr`, `asj`, `fin`,
    `mid`, `remaining`, plus `<id>_XX`/`<id>_XY` sex strata which we ignore.
  - When `joint` is null we fall back to `exome` (smaller cohort but still
    informative).

On any network/parse failure we return an empty list so the pipeline degrades
gracefully (matches the "deterministic result always renders" contract in PRD
§6.7).
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
    variant_id
    joint {
      ac
      an
      populations { id ac an }
    }
    exome {
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


def _af(ac: Optional[int], an: Optional[int]) -> Optional[float]:
    if not an:
        return None
    return (ac or 0) / an


def lookup(
    chrom: str, pos: int, ref: str, alt: str,
    *, timeout: float = 5.0, client: Optional[httpx.Client] = None,
) -> list[PopulationAF]:
    """Return up to two rows: gnomad_v4_global + gnomad_v4_sas.

    Empty list if the variant is unknown to gnomAD or the request fails.
    """
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

    if payload.get("errors"):
        log.debug("gnomAD returned errors for %s: %s", vid, payload["errors"])

    # Distinguish "API responded, variant absent from gnomAD" from a transport
    # failure: a successful response with `variant: null` means true absence
    # (allele count 0 across gnomAD) — strong PM2 support — so we emit an
    # explicit af=0 row. Transport/parse failures returned [] earlier, so a
    # *missing* row downstream unambiguously means "gnomAD was not consulted."
    if "data" in payload:
        variant = (payload.get("data") or {}).get("variant")
        if not variant:
            return [PopulationAF(source="gnomad_v4_global", ac=0, an=None, af=0.0)]
    else:
        return []

    # Prefer 'joint' (exomes + genomes); fall back to 'exome' alone if joint missing.
    src = variant.get("joint") or variant.get("exome")
    if not src:
        return [PopulationAF(source="gnomad_v4_global", ac=0, an=None, af=0.0)]

    global_ac = src.get("ac")
    global_an = src.get("an")
    global_af = src.get("af")  # 'exome' has it, 'joint' doesn't — compute if missing.
    if global_af is None:
        global_af = _af(global_ac, global_an)

    out: list[PopulationAF] = [PopulationAF(
        source="gnomad_v4_global",
        ac=global_ac, an=global_an, af=global_af,
    )]
    # Filter populations to the SAS slice (skip XX/XY strata).
    for pop in src.get("populations") or []:
        if pop.get("id") == "sas":
            out.append(PopulationAF(
                source="gnomad_v4_sas",
                ac=pop.get("ac"),
                an=pop.get("an"),
                af=_af(pop.get("ac"), pop.get("an")),
            ))
            break
    return out


def lookup_batch(
    variants: Iterable[tuple[str, int, str, str]],
    *, timeout: float = 5.0,
) -> dict[tuple[str, int, str, str], list[PopulationAF]]:
    """Sequential batch — reuses a single HTTPX client (TCP keep-alive). gnomAD
    GraphQL doesn't have a true bulk-variant query; each variant is one request.
    The Worker layer caches via the AI Gateway HTTP cache so repeat queries are
    near-free."""
    out: dict[tuple[str, int, str, str], list[PopulationAF]] = {}
    with httpx.Client(timeout=timeout, headers={"User-Agent": "variantgpt-engine/0.1"}) as client:
        for v in variants:
            out[v] = lookup(*v, client=client)
    return out
