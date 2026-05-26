"""Pipeline-stage checkpointing via signed R2 URLs.

The Worker hands the engine a `cache_urls` dict at /run start:

    {
      "af_map":   {"get": "<signed R2 GET>", "put": "<signed R2 PUT>"},
      "csq":      {"get": "...",             "put": "..."},
      "variants": {"get": "...",             "put": "..."}
    }

Each pair points at a single R2 object under `cases/<id>/cache/<stage>.json.gz`.
Before an expensive stage runs, the engine calls `try_load` to see if the
prior run's output is cached. If yes, skip the stage. If no, run the stage
and `save` the result.

The serialization format is gzipped JSON throughout. Compact, easy to
inspect manually with `zcat`, and pydantic-compatible.

This module is NOT a general-purpose cache — it's tied to the specific
pipeline shapes (af_map = dict[key, float], csq = dict[key, list[dict]],
variants = list[Variant.model_dump()]). Adding a new stage requires
defining its (de)serialization here.
"""
from __future__ import annotations

import gzip
import json
import logging
from typing import Optional

import httpx

from .joint import JointVariant
from .models import Variant

log = logging.getLogger(__name__)
CACHE_LOAD_TIMEOUT = 30.0
CACHE_SAVE_TIMEOUT = 60.0


# ─────────────────────── HTTP helpers ───────────────────────


async def _http_get(url: str) -> Optional[bytes]:
    """Fetch a cache blob. Returns None on 404 (cache miss) or any error.
    Errors are logged but never re-raised — cache misses must never block
    the main pipeline."""
    try:
        async with httpx.AsyncClient(timeout=CACHE_LOAD_TIMEOUT) as client:
            resp = await client.get(url)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.content
    except Exception as e:  # noqa: BLE001
        log.info("cache GET failed (treated as miss): %s", e)
        return None


async def _http_put(url: str, body: bytes) -> bool:
    try:
        async with httpx.AsyncClient(timeout=CACHE_SAVE_TIMEOUT) as client:
            resp = await client.put(
                url,
                content=body,
                headers={"content-type": "application/json"},
            )
        resp.raise_for_status()
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("cache PUT failed: %s", e)
        return False


def _gzip_dumps(obj) -> bytes:
    return gzip.compress(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _gzip_loads(b: bytes):
    return json.loads(gzip.decompress(b).decode("utf-8"))


# ─────────────────────── AF map (dict[key, float]) ───────────────────────


async def load_af_map(url: str) -> Optional[dict[tuple[str, int, str, str], float]]:
    raw = await _http_get(url)
    if raw is None:
        return None
    try:
        flat = _gzip_loads(raw)
        # JSON serialized {f"{chrom}:{pos}:{ref}:{alt}": af}; restore tuple keys.
        out: dict[tuple[str, int, str, str], float] = {}
        for k, v in flat.items():
            parts = k.split(":")
            if len(parts) >= 4:
                chrom, pos, ref, alt = parts[0], int(parts[1]), parts[2], ":".join(parts[3:])
                out[(chrom, pos, ref, alt)] = float(v)
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("cache AF deserialize failed: %s", e)
        return None


async def save_af_map(url: str, af_map: dict[tuple[str, int, str, str], float]) -> bool:
    flat = {f"{k[0]}:{k[1]}:{k[2]}:{k[3]}": v for k, v in af_map.items()}
    return await _http_put(url, _gzip_dumps(flat))


# ─────────────────────── CSQ (dict[key, list[dict]]) ───────────────────────
# Stores VEP CSQ annotations per JointVariant key. On load, the engine
# iterates surviving joint variants and re-attaches jv.csq from the cache.


async def load_csq(url: str) -> Optional[dict[tuple[str, int, str, str], list[dict[str, str]]]]:
    raw = await _http_get(url)
    if raw is None:
        return None
    try:
        flat = _gzip_loads(raw)
        out: dict[tuple[str, int, str, str], list[dict[str, str]]] = {}
        for k, v in flat.items():
            parts = k.split(":")
            if len(parts) >= 4:
                chrom, pos, ref, alt = parts[0], int(parts[1]), parts[2], ":".join(parts[3:])
                out[(chrom, pos, ref, alt)] = v
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("cache CSQ deserialize failed: %s", e)
        return None


async def save_csq(url: str, joint: list[JointVariant]) -> bool:
    flat = {f"{jv.chrom}:{jv.pos}:{jv.ref}:{jv.alt}": jv.csq for jv in joint if jv.csq}
    return await _http_put(url, _gzip_dumps(flat))


def apply_csq_cache(
    joint: list[JointVariant],
    csq_map: dict[tuple[str, int, str, str], list[dict[str, str]]],
) -> int:
    """Re-attach cached CSQ entries to surviving JointVariants. Returns the
    count of variants that got CSQ from cache."""
    hits = 0
    for jv in joint:
        if jv.csq:
            continue  # already has CSQ (e.g. from input VCF)
        cached = csq_map.get((jv.chrom, jv.pos, jv.ref, jv.alt))
        if cached:
            jv.csq = cached
            hits += 1
    return hits


# ─────────────────────── Variants (list[Variant]) ───────────────────────
# Cached as a list of Variant.model_dump() dicts. Used so a successful
# annotate+classify doesn't need to be redone on a rerun where only the
# ClinVar overlay failed.


async def load_variants(url: str) -> Optional[list[Variant]]:
    raw = await _http_get(url)
    if raw is None:
        return None
    try:
        data = _gzip_loads(raw)
        return [Variant.model_validate(d) for d in data]
    except Exception as e:  # noqa: BLE001
        log.warning("cache variants deserialize failed: %s", e)
        return None


async def save_variants(url: str, variants: list[Variant]) -> bool:
    data = [v.model_dump(mode="json") for v in variants]
    return await _http_put(url, _gzip_dumps(data))
