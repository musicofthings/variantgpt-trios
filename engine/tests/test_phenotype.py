"""Phenotype-proximity scoring tests (PRD §4.7).

Builds a tiny synthetic HPO DAG + gene annotations in-memory (no network)
to exercise the coverage / Resnik BMA / Phrank arms of PhenotypeScorer and
the normalization invariants.
"""
from __future__ import annotations

import pytest

from variantgpt_engine.annotation_sources import hpo_genes, hpo_ontology
from variantgpt_engine.phenotype import PhenotypeScorer

# Synthetic ontology:  root <- A <- {A1, A2} ;  root <- B <- B1
_PARENTS = {
    "HP:root": set(),
    "HP:A": {"HP:root"}, "HP:A1": {"HP:A"}, "HP:A2": {"HP:A"},
    "HP:B": {"HP:root"}, "HP:B1": {"HP:B"},
}
_GENES = {
    "GENE_EXACT": {"HP:A1", "HP:B1"},   # exactly the case terms
    "GENE_SIBLING": {"HP:A2"},          # sibling of a case term (shares parent A)
    "GENE_HALF": {"HP:B1"},             # one of two case terms, exact
    "GENE_ROOT": {"HP:root"},           # only the root — IC 0, no relevance
    # filler genes so IC isn't degenerate
    "G1": {"HP:A1"}, "G2": {"HP:A2"}, "G3": {"HP:B1"},
    "G4": {"HP:A"}, "G5": {"HP:B"},
}


@pytest.fixture
def loaded_ontology(monkeypatch):
    monkeypatch.setattr(hpo_ontology._Lazy, "parents", dict(_PARENTS))
    monkeypatch.setattr(hpo_ontology._Lazy, "name", {k: k for k in _PARENTS})
    monkeypatch.setattr(hpo_ontology._Lazy, "_anc_cache", {})
    monkeypatch.setattr(hpo_ontology._Lazy, "loaded", True)
    monkeypatch.setattr(hpo_genes._Lazy, "gene_to_hpo", {k: set(v) for k, v in _GENES.items()})
    hpo_ontology._compute_ic()
    yield


CASE = ["HP:A1", "HP:B1"]


def test_exact_match_scores_full(loaded_ontology):
    s = PhenotypeScorer(CASE)
    r = s.score("GENE_EXACT")
    assert r is not None
    assert r.coverage.percent == 100.0
    assert r.resnik.percent == 100.0
    assert r.phrank.percent == 100.0


def test_sibling_gets_graded_credit_but_zero_coverage(loaded_ontology):
    """The headline value-add: a gene linked to a *sibling* of a case term
    earns 0% exact coverage but non-zero graded relevance."""
    s = PhenotypeScorer(CASE)
    r = s.score("GENE_SIBLING")
    assert r is not None
    assert r.coverage.percent == 0.0
    assert r.resnik.percent > 0.0
    assert r.phrank.percent > 0.0


def test_half_coverage(loaded_ontology):
    s = PhenotypeScorer(CASE)
    r = s.score("GENE_HALF")
    assert r.coverage.percent == 50.0


def test_root_only_gene_has_no_relevance(loaded_ontology):
    """A gene annotated only to the (IC-0) root is phenotypically uninformative."""
    s = PhenotypeScorer(CASE)
    assert s.score("GENE_ROOT") is None


def test_unannotated_gene_returns_none(loaded_ontology):
    s = PhenotypeScorer(CASE)
    assert s.score("NOT_A_GENE") is None
    assert s.score(None) is None


def test_contributions_sum_to_percent(loaded_ontology):
    """Per-term contributions must sum to percent/100 for every arm."""
    s = PhenotypeScorer(CASE)
    r = s.score("GENE_EXACT")
    for arm in (r.coverage, r.resnik, r.phrank):
        total = sum(c.contribution for c in arm.matched_terms)
        assert total == pytest.approx(arm.percent / 100.0, abs=1e-3)


def test_no_case_terms_yields_none(loaded_ontology):
    s = PhenotypeScorer([])
    assert s.score("GENE_EXACT") is None


def test_coverage_only_when_ontology_absent(monkeypatch):
    """With the ontology unloaded, resnik/phrank mirror coverage so the
    columns are never blank."""
    monkeypatch.setattr(hpo_ontology._Lazy, "loaded", False)
    monkeypatch.setattr(hpo_genes._Lazy, "gene_to_hpo", {k: set(v) for k, v in _GENES.items()})
    s = PhenotypeScorer(CASE)
    r = s.score("GENE_HALF")
    assert r is not None
    assert r.resnik.percent == r.coverage.percent
    assert r.phrank.percent == r.coverage.percent
