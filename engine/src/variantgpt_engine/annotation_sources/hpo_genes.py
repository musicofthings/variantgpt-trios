"""HPO → gene mapping for phenotype-driven variant prioritization.

Source: HPO consortium's `genes_to_phenotype.txt` (~20 MB, 329k mappings).
URL: https://purl.obolibrary.org/obo/hp/hpoa/genes_to_phenotype.txt

The engine downloads this once per Fly machine lifetime (cached in
/tmp/variantgpt/g2p.txt) and parses into two in-memory dicts:
  gene_to_hpo:  gene_symbol → set[hpo_id]
  hpo_to_gene:  hpo_id → set[gene_symbol]

Use case in the pipeline: after variants are classified, we check which
of the case's HPO terms each variant's gene is associated with. Variants
with HPO matches get a `hpo_matches: [list of HPO IDs]` attribute and a
priority_score boost so they surface in the Workbench's default sort.

File format (tab-separated):
  ncbi_gene_id | gene_symbol | hpo_id | hpo_name | frequency | disease_id

We only need gene_symbol + hpo_id; everything else is dropped at load.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Iterable, Optional

import httpx

log = logging.getLogger(__name__)

HPO_URL = "https://purl.obolibrary.org/obo/hp/hpoa/genes_to_phenotype.txt"
LOCAL_CACHE = Path(os.environ.get("HPO_G2P_PATH", "/tmp/variantgpt/g2p.txt"))


class _Lazy:
    """Holds the loaded HPO maps. Built once per process; reused across cases."""
    gene_to_hpo: dict[str, set[str]] = {}
    hpo_to_gene: dict[str, set[str]] = {}
    loaded: bool = False


def _parse(path: Path) -> None:
    """Stream-parse the TSV into the two lookup dicts."""
    g2h: dict[str, set[str]] = {}
    h2g: dict[str, set[str]] = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        header = fh.readline()
        if not header.startswith("ncbi_gene_id"):
            log.warning("HPO g2p file: unexpected header: %r", header[:80])
        for line in fh:
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 3:
                continue
            gene = cols[1].strip()
            hpo = cols[2].strip()
            if not gene or not hpo or not hpo.startswith("HP:"):
                continue
            g2h.setdefault(gene, set()).add(hpo)
            h2g.setdefault(hpo, set()).add(gene)
    _Lazy.gene_to_hpo = g2h
    _Lazy.hpo_to_gene = h2g
    _Lazy.loaded = True
    log.info(
        "HPO maps loaded: %d genes, %d HPO terms",
        len(g2h), len(h2g),
    )


async def ensure_loaded(timeout: float = 60.0) -> bool:
    """Download (if missing) + parse the HPO file. Idempotent; safe to
    call once per /run. Returns True if maps are ready, False if anything
    fell over (the pipeline degrades to no-HPO-matching mode silently)."""
    if _Lazy.loaded:
        return True

    if not LOCAL_CACHE.exists() or LOCAL_CACHE.stat().st_size < 1_000_000:
        LOCAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = LOCAL_CACHE.with_suffix(".tmp")
        try:
            t = time.time()
            log.info("downloading HPO g2p from %s", HPO_URL)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                async with client.stream("GET", HPO_URL) as resp:
                    resp.raise_for_status()
                    with open(tmp, "wb") as out:
                        async for chunk in resp.aiter_bytes():
                            out.write(chunk)
            tmp.replace(LOCAL_CACHE)
            log.info(
                "HPO g2p downloaded in %ds (%.1f MB)",
                int(time.time() - t),
                LOCAL_CACHE.stat().st_size / 1024 / 1024,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("HPO g2p download failed: %s", e)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
            return False

    try:
        _parse(LOCAL_CACHE)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("HPO g2p parse failed: %s", e)
        return False


def match_gene(gene: Optional[str], case_hpo_ids: Iterable[str]) -> list[str]:
    """Return the subset of case_hpo_ids whose gene-association catalog
    includes `gene`. Order preserves case_hpo_ids order so the first
    listed HPO appears first."""
    if not gene or not _Lazy.loaded:
        return []
    gene_hpos = _Lazy.gene_to_hpo.get(gene)
    if not gene_hpos:
        return []
    return [h for h in case_hpo_ids if h in gene_hpos]


def gene_hpo_count(gene: Optional[str]) -> int:
    """Total number of HPO terms associated with `gene` (across all diseases).
    Useful for context — a gene with 200 HPO associations is more pleiotropic
    than one with 3."""
    if not gene or not _Lazy.loaded:
        return 0
    return len(_Lazy.gene_to_hpo.get(gene, set()))
