"""HPO ontology DAG + information content for phenotype-proximity scoring.

`hpo_genes.py` answers the *boolean* question "is this gene directly
associated with this HPO term?". This module answers the *graded* question
"how phenotypically close is this gene to the patient's terms?" by walking
the HPO is_a hierarchy.

Source: HPO consortium OBO release.
URL: https://purl.obolibrary.org/obo/hp.obo  (~10 MB, ~19k terms)

Loaded once per process (cached in /tmp/variantgpt/hp.obo) into:
  parents:    hpo_id -> set[parent hpo_id]   (is_a edges only)
  name:       hpo_id -> term label
  _anc_cache: memoized ancestor closures (term + all is_a ancestors)

Information content (IC) is derived from the gene-annotation frequency in
`hpo_genes` (genes_to_phenotype): a term annotated to few genes is specific
(high IC); a term near the root annotated to thousands is generic (low IC).
IC(t) = -log( annotated_genes(t) / total_genes ), with annotation propagated
up the is_a graph (a gene annotated to a child is implicitly annotated to
every ancestor).

Scorers exposed:
  resnik(t1, t2)            -> IC of the most-informative common ancestor (MICA)
  best_match_average(...)   -> patient-driven Resnik BMA between two term sets
  phrank(gene_terms, ...)   -> sum of IC over shared ancestor closure (Phrank)

All scorers degrade to 0.0 (never raise) when the ontology failed to load,
so the pipeline silently falls back to coverage-only scoring.
"""
from __future__ import annotations

import logging
import math
import os
import time
from pathlib import Path
from typing import Iterable, Optional

import httpx

from . import hpo_genes

log = logging.getLogger(__name__)

OBO_URL = "https://purl.obolibrary.org/obo/hp.obo"
LOCAL_CACHE = Path(os.environ.get("HPO_OBO_PATH", "/tmp/variantgpt/hp.obo"))


class _Lazy:
    """Holds the loaded ontology. Built once per process; reused across cases."""
    parents: dict[str, set[str]] = {}
    name: dict[str, str] = {}
    ic: dict[str, float] = {}
    _anc_cache: dict[str, frozenset[str]] = {}
    loaded: bool = False


def _parse_obo(path: Path) -> tuple[dict[str, set[str]], dict[str, str]]:
    """Stream-parse hp.obo [Term] stanzas into parents + name maps.

    Only is_a edges are followed (HPO's primary backbone). Obsolete terms
    are dropped. alt_id / relationship / xref lines are ignored.
    """
    parents: dict[str, set[str]] = {}
    name: dict[str, str] = {}
    cur_id: Optional[str] = None
    cur_name: Optional[str] = None
    cur_parents: set[str] = set()
    obsolete = False
    in_term = False

    def flush() -> None:
        nonlocal cur_id, cur_name, cur_parents, obsolete
        if in_term and cur_id and not obsolete:
            parents[cur_id] = set(cur_parents)
            if cur_name:
                name[cur_id] = cur_name
        cur_id = None
        cur_name = None
        cur_parents = set()
        obsolete = False

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("[Term]"):
                flush()
                in_term = True
                continue
            if line.startswith("[") and line.endswith("]"):
                # Some other stanza type (e.g. [Typedef]) — close any open term.
                flush()
                in_term = False
                continue
            if not in_term:
                continue
            if line.startswith("id: HP:"):
                cur_id = line[4:].strip()
            elif line.startswith("name:"):
                cur_name = line[5:].strip()
            elif line.startswith("is_a:"):
                # "is_a: HP:0000005 ! mode of inheritance"
                rest = line[5:].strip()
                pid = rest.split("!", 1)[0].split()[0].strip() if rest else ""
                if pid.startswith("HP:"):
                    cur_parents.add(pid)
            elif line.startswith("is_obsolete:") and "true" in line:
                obsolete = True
    flush()
    return parents, name


def _ancestors(term: str) -> frozenset[str]:
    """Term itself + all is_a ancestors. Memoized; iterative to avoid
    recursion limits on deep chains."""
    cached = _Lazy._anc_cache.get(term)
    if cached is not None:
        return cached
    seen: set[str] = set()
    stack = [term]
    while stack:
        t = stack.pop()
        if t in seen:
            continue
        seen.add(t)
        stack.extend(_Lazy.parents.get(t, ()))
    fs = frozenset(seen)
    _Lazy._anc_cache[term] = fs
    return fs


def _closure(terms: Iterable[str]) -> set[str]:
    """Union of ancestor closures over a set of terms."""
    out: set[str] = set()
    for t in terms:
        out |= _ancestors(t)
    return out


def _compute_ic() -> None:
    """Derive per-term information content from gene-annotation frequency.

    For each gene, propagate its direct HPO terms up to all ancestors; a
    term's annotation count is the number of distinct genes annotated to it
    (with propagation). IC(t) = -log(count / total_genes).
    """
    g2h = hpo_genes._Lazy.gene_to_hpo
    if not g2h:
        log.warning("HPO IC: gene_to_hpo empty — IC will be uniform-zero")
        _Lazy.ic = {}
        return
    term_gene_count: dict[str, int] = {}
    total = 0
    for _gene, direct in g2h.items():
        # Skip genes whose direct terms aren't in this OBO release.
        anc = _closure(t for t in direct if t in _Lazy.parents)
        if not anc:
            continue
        total += 1
        for t in anc:
            term_gene_count[t] = term_gene_count.get(t, 0) + 1
    if total == 0:
        _Lazy.ic = {}
        return
    ic: dict[str, float] = {}
    for t, c in term_gene_count.items():
        # Clamp freq into (0,1]; -log(1.0)=0 for the root.
        freq = c / total
        ic[t] = -math.log(freq) if freq > 0 else 0.0
    _Lazy.ic = ic
    log.info("HPO IC computed over %d annotated genes, %d terms", total, len(ic))


async def ensure_loaded(timeout: float = 60.0) -> bool:
    """Download (if missing) + parse hp.obo and compute IC. Idempotent.
    Requires hpo_genes to be loaded first (for IC). Returns True if the
    ontology is ready, False if anything fell over (callers degrade to
    coverage-only scoring)."""
    if _Lazy.loaded:
        return True

    if not LOCAL_CACHE.exists() or LOCAL_CACHE.stat().st_size < 1_000_000:
        LOCAL_CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = LOCAL_CACHE.with_suffix(".tmp")
        try:
            t = time.time()
            log.info("downloading HPO obo from %s", OBO_URL)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                async with client.stream("GET", OBO_URL) as resp:
                    resp.raise_for_status()
                    with open(tmp, "wb") as out:
                        async for chunk in resp.aiter_bytes():
                            out.write(chunk)
            tmp.replace(LOCAL_CACHE)
            log.info(
                "HPO obo downloaded in %ds (%.1f MB)",
                int(time.time() - t),
                LOCAL_CACHE.stat().st_size / 1024 / 1024,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("HPO obo download failed: %s", e)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
            return False

    try:
        parents, name = _parse_obo(LOCAL_CACHE)
        if not parents:
            log.warning("HPO obo parse produced no terms")
            return False
        _Lazy.parents = parents
        _Lazy.name = name
        _Lazy._anc_cache = {}
        _compute_ic()
        _Lazy.loaded = True
        log.info("HPO ontology loaded: %d terms", len(parents))
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("HPO obo parse failed: %s", e)
        return False


def is_loaded() -> bool:
    return _Lazy.loaded


def label(term: str) -> Optional[str]:
    return _Lazy.name.get(term)


def ic_of(term: str) -> float:
    return _Lazy.ic.get(term, 0.0)


def resnik(t1: str, t2: str) -> float:
    """IC of the most informative common ancestor (MICA) of two terms."""
    if not _Lazy.loaded:
        return 0.0
    common = _ancestors(t1) & _ancestors(t2)
    if not common:
        return 0.0
    return max((_Lazy.ic.get(t, 0.0) for t in common), default=0.0)


def best_match_average(query_terms: list[str], target_terms: list[str]) -> float:
    """Asymmetric Resnik best-match-average, query-driven: for each query
    term, the best Resnik similarity to any target term, averaged over query
    terms. Used patient-driven (query = patient HPO, target = gene HPO) so
    the score reflects how well the gene covers the patient's phenotype."""
    if not _Lazy.loaded or not query_terms or not target_terms:
        return 0.0
    total = 0.0
    for q in query_terms:
        total += max((resnik(q, t) for t in target_terms), default=0.0)
    return total / len(query_terms)


def best_match_per_query(query_terms: list[str], target_terms: list[str]) -> dict[str, float]:
    """Per-query-term best Resnik match — feeds the UI contribution breakdown."""
    out: dict[str, float] = {}
    if not _Lazy.loaded or not target_terms:
        return {q: 0.0 for q in query_terms}
    for q in query_terms:
        out[q] = max((resnik(q, t) for t in target_terms), default=0.0)
    return out


def phrank(gene_terms: list[str], case_terms: list[str]) -> float:
    """Phrank-style similarity: sum of IC over the ancestor closure shared
    by the gene's term set and the patient's term set. Rewards genes that
    share specific (high-IC) ancestors with the patient's phenotype."""
    if not _Lazy.loaded or not gene_terms or not case_terms:
        return 0.0
    shared = _closure(gene_terms) & _closure(case_terms)
    return sum(_Lazy.ic.get(t, 0.0) for t in shared)


def closure_ic_sum(terms: list[str]) -> float:
    """Sum of IC over a term set's ancestor closure — the Phrank
    self-similarity denominator (a perfect-match gene)."""
    if not _Lazy.loaded or not terms:
        return 0.0
    return sum(_Lazy.ic.get(t, 0.0) for t in _closure(terms))


def phrank_per_query(gene_terms: list[str], case_terms: list[str]) -> dict[str, float]:
    """Per-case-term shared-IC: for each case term, the IC mass of its
    ancestor closure that the gene's closure also covers. Feeds the UI
    contribution breakdown (ancestors shared across case terms are counted
    per term, so callers normalize for display)."""
    if not _Lazy.loaded or not gene_terms or not case_terms:
        return {c: 0.0 for c in case_terms}
    gene_closure = _closure(gene_terms)
    out: dict[str, float] = {}
    for c in case_terms:
        shared = _ancestors(c) & gene_closure
        out[c] = sum(_Lazy.ic.get(t, 0.0) for t in shared)
    return out
