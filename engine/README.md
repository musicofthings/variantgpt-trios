# variantgpt-engine

Off-edge Python engine. Runs on Colab/container/CI — NOT on Cloudflare Workers.

Pipeline (PRD §6.3, §9):

1. Intake — parse pedigree + per-member VCFs.
2. Build detect / liftover — canonicalize to GRCh38; flag lift-failed.
3. Normalize — `bcftools norm -m- -f <ref>` (split multiallelics, left-align, trim).
4. Joint merge — joint genotype matrix keyed by normalized variant.
5. QC — Mendelian errors, sex check, kinship, contamination heuristic.
6. Inheritance modeling — generalized pedigree (de novo, AR-hom, comp-het with phasing, dominant, X/Y/mito, segregation).
7. Annotation — VEP/ANNOVAR + ClinVar + gnomAD(sas) + IndiGenomes/GenomeAsia + predictors + HPO.
8. ACMG point engine — ClinGen SVI Bayesian, signed criterion strengths, evidence ledger.
9. South Asian reclassification — VUS-only; PM2 retraction, BA1/BS1 re-eval, founder-pathogenic flag.
10. Emit `case.json` + candidate variant set.

## CLI
```
variantgpt-engine run \
    --ped case.ped \
    --vcf proband=proband.vcf.gz --vcf father=father.vcf.gz --vcf mother=mother.vcf.gz \
    --hpo HP:0001250,HP:0001263 \
    --build auto \
    --out case.json
```
