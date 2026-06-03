"""Phenotype-proximity scoring (PRD §4.7).

Given the case's HPO terms, score how phenotypically close each variant's
gene is to the patient, under three interchangeable algorithms. All three
are precomputed per variant and baked into case.json so the Analysis
Workbench can switch between them instantly (a display toggle, not a
recompute).

  coverage — fraction of the case's HPO terms the gene is *directly*
             associated with (exact genes_to_phenotype match). No ontology;
             always available.
  resnik   — Resnik best-match-average over the HPO is_a DAG. A gene linked
             to a parent/child of a case term earns partial credit.
  phrank   — sum of information content over the shared ancestor closure.

Each algorithm returns a 0..100 percent = gene_score / perfect_match_score,
so a gene whose phenotype perfectly covers the patient's terms scores ~100%.
The resnik/phrank arms require `hpo_ontology` to be loaded; when it isn't,
they fall back to the coverage value so the column is never blank.
"""
from __future__ import annotations

from typing import Optional

from .annotation_sources import hpo_genes, hpo_ontology
from .models import (
    GenePhenotype,
    PhenotypeRelevance,
    PhenotypeScore,
    PhenotypeTermContribution,
)


def gene_phenotype_terms(
    gene: Optional[str],
    case_hpo_ids: Optional[list[str]] = None,
    limit: int = 15,
) -> tuple[list[GenePhenotype], int]:
    """The HPO terms a gene is associated with in the genes_to_phenotype
    catalog, for clinical-utility context independent of the case phenotype.

    Returns (top_slice, total). The slice is capped at `limit` and ordered so
    that terms also present in the case phenotype come first, then by
    descending information content (most specific/informative first) when the
    ontology is loaded. `total` is the gene's full association count so the UI
    can show "+N more". Returns ([], 0) when the gene has no associations."""
    if not gene or not hpo_genes._Lazy.loaded:
        return [], 0
    terms = hpo_genes._Lazy.gene_to_hpo.get(gene)
    if not terms:
        return [], 0
    case_set = set(case_hpo_ids or [])
    onto = hpo_ontology.is_loaded()
    ordered = sorted(
        terms,
        key=lambda t: (
            t not in case_set,  # case-matching terms first
            -(hpo_ontology.ic_of(t) if onto else 0.0),  # then most specific
            t,  # stable tiebreak
        ),
    )
    out = [
        GenePhenotype(
            hpo_id=t,
            label=hpo_ontology.label(t) if onto else None,
            matches_case=t in case_set,
        )
        for t in ordered[:limit]
    ]
    return out, len(terms)


def _norm_contributions(
    raw: dict[str, float],
    percent: float,
    labels: dict[str, str],
) -> list[PhenotypeTermContribution]:
    """Turn per-term raw weights into normalized contributions that sum to
    percent/100, sorted by descending contribution. Drops zero-weight terms."""
    total = sum(v for v in raw.values() if v > 0)
    target = percent / 100.0
    out: list[PhenotypeTermContribution] = []
    if total <= 0:
        return out
    for hpo_id, v in raw.items():
        if v <= 0:
            continue
        out.append(
            PhenotypeTermContribution(
                hpo_id=hpo_id,
                label=labels.get(hpo_id) or hpo_ontology.label(hpo_id),
                contribution=round((v / total) * target, 4),
            )
        )
    out.sort(key=lambda c: c.contribution, reverse=True)
    return out


class PhenotypeScorer:
    """Scores genes against a fixed set of case HPO terms. Construct once per
    case, then call `.score(gene)` per variant — the per-case normalization
    denominators are computed up front."""

    def __init__(self, case_hpo_ids: list[str], labels: Optional[dict[str, str]] = None):
        self.case = list(dict.fromkeys(case_hpo_ids))  # dedupe, preserve order
        self.labels = labels or {}
        self.n = len(self.case)
        self.ontology = hpo_ontology.is_loaded()

        # Resnik denominator: sum of self-similarity (= IC) over case terms.
        self._resnik_denom = 0.0
        if self.ontology:
            self._resnik_denom = sum(hpo_ontology.ic_of(c) for c in self.case)
        # Phrank denominator: IC sum over the case's full ancestor closure.
        self._phrank_denom = hpo_ontology.closure_ic_sum(self.case) if self.ontology else 0.0

    # --- individual algorithms -------------------------------------------

    def _coverage(self, gene_terms: set[str]) -> PhenotypeScore:
        if self.n == 0:
            return PhenotypeScore()
        matched = [c for c in self.case if c in gene_terms]
        percent = round(100.0 * len(matched) / self.n, 1)
        raw = {c: 1.0 for c in matched}
        return PhenotypeScore(
            percent=percent,
            matched_terms=_norm_contributions(raw, percent, self.labels),
        )

    def _resnik(self, gene_term_list: list[str]) -> PhenotypeScore:
        if not self.ontology or self._resnik_denom <= 0 or not gene_term_list:
            return PhenotypeScore()
        per_q = hpo_ontology.best_match_per_query(self.case, gene_term_list)
        score = sum(per_q.values())
        percent = round(min(100.0, 100.0 * score / self._resnik_denom), 1)
        return PhenotypeScore(
            percent=percent,
            matched_terms=_norm_contributions(per_q, percent, self.labels),
        )

    def _phrank(self, gene_term_list: list[str]) -> PhenotypeScore:
        if not self.ontology or self._phrank_denom <= 0 or not gene_term_list:
            return PhenotypeScore()
        score = hpo_ontology.phrank(gene_term_list, self.case)
        percent = round(min(100.0, 100.0 * score / self._phrank_denom), 1)
        per_q = hpo_ontology.phrank_per_query(gene_term_list, self.case)
        return PhenotypeScore(
            percent=percent,
            matched_terms=_norm_contributions(per_q, percent, self.labels),
        )

    # --- public ----------------------------------------------------------

    def score(self, gene: Optional[str]) -> Optional[PhenotypeRelevance]:
        """Full relevance under all three algorithms. Returns None when the
        gene has no HPO associations at all (nothing to score)."""
        if not gene or self.n == 0:
            return None
        gene_terms = hpo_genes._Lazy.gene_to_hpo.get(gene)
        if not gene_terms:
            return None
        gene_term_list = list(gene_terms)

        coverage = self._coverage(gene_terms)
        resnik = self._resnik(gene_term_list)
        phrank = self._phrank(gene_term_list)
        # When the ontology isn't loaded, mirror coverage so the graded
        # columns aren't blank.
        if not self.ontology:
            resnik = coverage
            phrank = coverage
        if coverage.percent == 0 and resnik.percent == 0 and phrank.percent == 0:
            return None
        return PhenotypeRelevance(coverage=coverage, resnik=resnik, phrank=phrank)
