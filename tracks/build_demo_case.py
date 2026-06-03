"""Run the engine end-to-end on the demo trio → emit case.json for the SPA.

Pre-req: run `python tracks/build_demo_vcfs.py` first to produce the trio.

Writes:
    app/web/public/demo/case.json   (consumed by the SPA via fetch('/demo/case.json'))
    data/test/demo_trio/case.json   (canonical engine output)
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "src"))

from variantgpt_engine.acmg import augment_context_evidence  # noqa: E402
from variantgpt_engine.annotation_sources import hpo_genes, hpo_ontology  # noqa: E402
from variantgpt_engine.pedigree import load_ped  # noqa: E402
from variantgpt_engine.phenotype import PhenotypeScorer, gene_phenotype_terms  # noqa: E402
from variantgpt_engine.pipeline import run_case  # noqa: E402


async def _score_phenotype(emission) -> int:
    """Attach phenotype-relevance to the demo variants. Mirrors what the
    container pipeline does for real cases; downloads the HPO catalogs if
    they aren't cached. Returns the number of scored variants (0 when the
    catalogs are unavailable offline)."""
    if not await hpo_genes.ensure_loaded():
        print("  HPO genes_to_phenotype unavailable — demo will have no relevance scores")
        return 0
    onto_ok = await hpo_ontology.ensure_loaded()
    if not onto_ok:
        print("  hp.obo unavailable — demo relevance limited to coverage")
    labels = {h.hpo_id: h.label for h in emission.hpo if h.label}
    case_hpo_ids = [h.hpo_id for h in emission.hpo]
    scorer = PhenotypeScorer(case_hpo_ids, labels=labels)
    n = 0
    for v in emission.variants:
        # Gene's catalog phenotypes for clinical-utility context, regardless
        # of whether any case HPO term overlaps the gene.
        gene_phenos, gene_pheno_total = gene_phenotype_terms(v.gene, case_hpo_ids)
        v.gene_phenotypes = gene_phenos
        v.gene_phenotype_total = gene_pheno_total

        rel = scorer.score(v.gene)
        if rel is None:
            continue
        v.phenotype_relevance = rel
        v.hpo_matches = [c.hpo_id for c in rel.coverage.matched_terms]
        v.priority_score = (v.priority_score or 0) + 0.5 * (
            (rel.phrank.percent if onto_ok else rel.coverage.percent) / 100.0
        )
        n += 1
    return n

TRIO = ROOT / "data" / "test" / "demo_trio"
WEB_PUBLIC = ROOT / "app" / "web" / "public" / "demo"


def main() -> None:
    ped_path = TRIO / "family.ped"
    if not ped_path.exists():
        print("missing demo VCFs — run: python tracks/build_demo_vcfs.py", file=sys.stderr)
        sys.exit(1)

    pedigree = load_ped(ped_path)

    # Map roles → VCF paths. The PED's iid identifies the sample; we name the
    # VCF files by role so the wiring is obvious.
    vcf_map = {
        m.id: TRIO / f"{m.role.value}.vcf"
        for m in pedigree.members
    }
    for p in vcf_map.values():
        if not p.exists():
            print(f"missing {p}", file=sys.stderr)
            sys.exit(1)

    # HPO terms relevant to the demo (matches the suggested ones in Intake.tsx).
    hpo = [
        "HP:0001903",  # Anemia (HBB)
        "HP:0002240",  # Hepatomegaly
        "HP:0002910",  # Elevated hepatic transaminases
        "HP:0003124",  # Hypercholesterolemia (placeholder)
    ]

    emission = run_case(
        case_id="demo-trio-001",
        pedigree=pedigree,
        vcf_paths=vcf_map,
        hpo_ids=hpo,
        build="GRCh38",
        use_demo_annotations=True,
    )

    scored = asyncio.run(_score_phenotype(emission))
    print(f"  phenotype-scored {scored} variants against {len(hpo)} HPO terms")

    # Re-run the context-aware ACMG criteria now that phenotype scores exist,
    # so the demo reflects PP4 (and any PM3/PP1) firing. run_case already ran
    # them once with no phenotype data; this second pass is idempotent and
    # re-tallies the baseline.
    ctx_fired = augment_context_evidence(emission.variants, emission.pedigree)
    print(f"  ACMG context: PP4={ctx_fired['PP4']} PM3={ctx_fired['PM3']} PP1={ctx_fired['PP1']}")

    out_engine = TRIO / "case.json"
    out_engine.write_text(emission.model_dump_json(indent=2), encoding="utf-8")

    WEB_PUBLIC.mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / "case.json").write_text(emission.model_dump_json(indent=2), encoding="utf-8")

    # Stats summary
    data = json.loads((WEB_PUBLIC / "case.json").read_text(encoding="utf-8"))
    tier_counts: dict[str, int] = {}
    for v in data["variants"]:
        tier_counts[v.get("baseline_tier") or "—"] = tier_counts.get(v.get("baseline_tier") or "—", 0) + 1
    print(f"wrote {out_engine}")
    print(f"wrote {WEB_PUBLIC / 'case.json'}")
    print(f"  variants={len(data['variants'])}  proposals={len(data['proposals'])}")
    print(f"  tiers={tier_counts}")


if __name__ == "__main__":
    main()
