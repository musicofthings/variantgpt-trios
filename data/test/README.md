# data/test/

Test fixtures (PRD §8). Do NOT commit large VCFs — gitignored.

Expected files (downloaded locally / in CI):
- `giab/HG002.GRCh38.vcf.gz` + `.tbi`
- `giab/HG003.GRCh38.vcf.gz` + `.tbi`
- `giab/HG004.GRCh38.vcf.gz` + `.tbi`
- `clinvar_benchmark.tsv` — curated 2-star+ benchmark for concordance.
- `sas_common_seeds.tsv` — variants known to be common in IndiGenomes /
  gnomAD-sas but rare global, to validate reclassification (PM2 retraction /
  BS1 application → VUS→LB proposal, never auto-committed).
- `synthetic_pedigrees/` — non-trio configurations (affected parent,
  sib-ship, consanguinity, missing member).
