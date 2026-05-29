"""GenomeAsia 100K AF lookup from R2.

Companion to `tracks/ingest_genomeasia.py`. That script writes a per-chrom
TSV.gz (`chrom \\t pos \\t ref \\t alt \\t af \\t ac \\t an`) into R2 under a
versioned prefix (default `tracks/genomeasia/v1`). This module reads those
TSVs and returns AF per variant.

Activation:
  - Worker injects a signed-URL map via the run payload as
    `genomeasia_af_url_template`. We accept two encodings:
      (a) Literal URL with `{chrom}` placeholder (legacy single-prefix
          case where sigv4 doesn't include the filename)
      (b) `json:<base64-json>` — the base64 decodes to a JSON object
          `{chrom: signed_url}`. This is the production case because
          R2 sigv4 signs the full path; one signed URL per chrom is the
          only correct shape.
  - When the env var / payload field is absent, adapter is a silent no-op.

Performance notes:
  - Each chrom TSV is ~5–50 MB compressed; full scan ~1–3 s.
  - We do ONE pass per unique chrom in the proband's candidate set
    (typically all 22 + indels), but cache the in-memory lookup table
    per chrom so re-queries during the same run are free.
  - For 8k candidate variants across all chroms, total lookup cost is
    ~30–60 s wall time on cold caches.

The lookup matches on literal VCF allele representation. The engine emits
canonical normalized alleles so the match is direct; we don't need
ANNOVAR-style coordinate gymnastics here (the upstream GenomeAsia files
use the standard VCF convention).
"""
from __future__ import annotations

import base64
import gzip
import io
import json
import logging
import os
from collections import defaultdict
from typing import Iterable, Optional

import httpx

from ..models import PopulationAF, Variant

log = logging.getLogger(__name__)

# Env var the engine reads to discover the signed-URL template. The Worker
# is responsible for minting + injecting this into the engine run payload
# (the same way it injects the IndiGen proxy URL + bearer).
ENV_AF_URL_TEMPLATE = "GENOMEASIA_AF_URL_TEMPLATE"

# Per-process cache: {chrom -> {(pos, ref, alt) -> af}}
_AF_CACHE: dict[str, dict[tuple[int, str, str], float]] = {}


def is_enabled() -> bool:
    return bool(os.environ.get(ENV_AF_URL_TEMPLATE))


async def fetch_for_variants(
    variants: Iterable[Variant],
    *,
    af_url_template: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
    progress: Optional[callable] = None,
) -> int:
    """Populate v.populations with a `genomeasia` row for each variant that
    has a hit in the GenomeAsia AF tables. Returns the count of hits.

    `af_url_template` overrides the env var (useful when the Worker passes
    it in the run payload). `{chrom}` placeholder is replaced per query.
    """
    template = af_url_template or os.environ.get(ENV_AF_URL_TEMPLATE)
    if not template:
        log.debug("GenomeAsia adapter not configured; skipping")
        return 0

    # Group variants by chrom so we make one pass per chrom file.
    by_chrom: dict[str, list[Variant]] = defaultdict(list)
    for v in variants:
        if not v.chrom or v.pos is None or not v.ref or not v.alt:
            continue
        ch = _normalize_chrom(v.chrom)
        # Indels go to the indels.tsv.gz file regardless of chrom.
        bucket = "indels" if (len(v.ref) > 1 or len(v.alt) > 1) else ch
        by_chrom[bucket].append(v)

    own_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=60.0)

    hits = 0
    try:
        for bucket, vs in by_chrom.items():
            await _ensure_chrom_loaded(bucket, template, client)
            table = _AF_CACHE.get(bucket, {})
            for v in vs:
                key = (v.pos, v.ref, v.alt)
                af = table.get(key)
                if af is None:
                    continue
                # Replace any prior `genomeasia` row; append otherwise.
                pops = [p for p in v.populations if p.source != "genomeasia"]
                pops.append(PopulationAF(source="genomeasia", af=af))
                v.populations = pops
                hits += 1
            if progress:
                progress(bucket, len(vs), hits)
    finally:
        if own_client:
            await client.aclose()

    return hits


async def _ensure_chrom_loaded(
    bucket: str,
    template: str,
    client: httpx.AsyncClient,
) -> None:
    """Download + parse the AF TSV for one chromosome (or 'indels') once
    per process. Subsequent calls reuse the in-memory table."""
    if bucket in _AF_CACHE:
        return
    url = _resolve_url(template, bucket)
    if not url:
        log.warning("GenomeAsia: no signed URL for %s; skipping", bucket)
        _AF_CACHE[bucket] = {}
        return
    log.info("GenomeAsia: loading %s", bucket)
    resp = await client.get(url)
    if resp.status_code == 404:
        log.warning("GenomeAsia: %s not found at upstream; skipping", bucket)
        _AF_CACHE[bucket] = {}
        return
    resp.raise_for_status()
    raw = resp.content
    table: dict[tuple[int, str, str], float] = {}
    with gzip.open(io.BytesIO(raw), "rt", encoding="ascii") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 5:
                continue
            try:
                pos = int(cols[1])
                af = float(cols[4])
            except ValueError:
                continue
            table[(pos, cols[2], cols[3])] = af
    _AF_CACHE[bucket] = table
    log.info("GenomeAsia: %s loaded (%d rows, %.1f MB)", bucket, len(table), len(raw) / 1e6)


def _normalize_chrom(c: str) -> str:
    return c if c.startswith("chr") else f"chr{c}"


_DECODED_MAP_CACHE: dict[str, dict[str, str]] = {}


def _resolve_url(template: str, bucket: str) -> Optional[str]:
    """Two template shapes supported:
      (a) Literal URL with `{chrom}` placeholder → replace in place.
      (b) `json:<base64>` — the base64 decodes to {chrom: signed_url}.
          The decoded map is cached per template string."""
    if template.startswith("json:"):
        decoded = _DECODED_MAP_CACHE.get(template)
        if decoded is None:
            try:
                raw = base64.b64decode(template[5:])
                decoded = json.loads(raw)
                if not isinstance(decoded, dict):
                    raise ValueError("not a dict")
            except Exception as e:  # noqa: BLE001
                log.error("GenomeAsia: bad json: template (%s)", e)
                return None
            _DECODED_MAP_CACHE[template] = decoded
        return decoded.get(bucket)
    return template.replace("{chrom}", bucket)
