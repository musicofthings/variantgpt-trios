"""End-to-end pipeline test on the synthetic trio.

Confirms that:
  - The joint merge picks up all alt-bearing variants across members.
  - De novo is correctly assigned to the variant unique to the proband.
  - The compound-het pair on the same gene is resolved in trans from parental
    phasing.
  - The ACMG point engine runs without crashing; PM2 fires for fully novel
    variants (no population data → all sources None → rare).
"""
from __future__ import annotations

from pathlib import Path

import pytest

cyvcf2 = pytest.importorskip("cyvcf2")  # noqa: F841

from variantgpt_engine.annotation import AnnotationContext, annotate  # noqa: E402
from variantgpt_engine.inheritance import assign_models, compound_het_pass  # noqa: E402
from variantgpt_engine.joint import merge  # noqa: E402
from variantgpt_engine.pedigree import load_ped  # noqa: E402


FIXTURE = Path(__file__).resolve().parents[2] / "data" / "test" / "synthetic_trio"


def test_synthetic_trio_inheritance_and_compound_het():
    pedigree = load_ped(FIXTURE / "family.ped")
    joint = merge({
        "proband": FIXTURE / "proband.vcf",
        "father":  FIXTURE / "father.vcf",
        "mother":  FIXTURE / "mother.vcf",
    })
    # Only alt-bearing positions should appear (chr1:500 is 0/0 in everyone).
    keys = {(v.chrom, v.pos) for v in joint}
    assert ("chr1", 100) in keys
    assert ("chr2", 200) in keys
    assert ("chr2", 300) in keys

    by_key = {(v.chrom, v.pos): v for v in joint}

    # De novo: chr1:100 — only proband carries the alt.
    models, conf = assign_models(by_key[("chr1", 100)], pedigree)
    assert "de_novo" in models
    assert conf in ("high", "medium", "low")

    # Compound het: chr2:200 (paternal) + chr2:300 (maternal), same gene.
    # We label both under a synthetic gene "GENE_X" so the gene-aware pass groups them.
    addl = compound_het_pass(
        [(by_key[("chr2", 200)], "GENE_X"), (by_key[("chr2", 300)], "GENE_X")],
        pedigree,
    )
    assert addl[by_key[("chr2", 200)].key] == ["comp_het"]
    assert addl[by_key[("chr2", 300)].key] == ["comp_het"]


def test_synthetic_trio_acmg_smoke():
    """Annotate (offline — no gnomAD/tabix) and classify; should not crash."""
    from variantgpt_engine.acmg import classify

    pedigree = load_ped(FIXTURE / "family.ped")
    joint = merge({
        "proband": FIXTURE / "proband.vcf",
        "father":  FIXTURE / "father.vcf",
        "mother":  FIXTURE / "mother.vcf",
    })
    ctx = AnnotationContext(build="GRCh38", use_gnomad=False, tracks=[])
    for jv in joint:
        v = annotate(jv, ctx)
        models, conf = assign_models(jv, pedigree)
        v.inheritance_models = models
        v.inheritance_confidence = conf  # type: ignore[assignment]
        tier, points, ledger = classify(v)
        assert tier in ("P", "LP", "VUS", "LB", "B")
        assert isinstance(points, int)
        assert any(e.criterion == "PM2" for e in ledger)
