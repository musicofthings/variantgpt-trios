# Deploying the BAM / SV-CNV pipeline

What the engine + Worker need at deploy time to run the aligned-reads (BAM/CRAM)
and structural-variant paths. Code is wired; these are the data/infra steps.

## 1. Reference genome → R2 (or baked into the engine)
Get the GATK/Broad GRCh38 bundle (must match how the BAMs were aligned):
`Homo_sapiens_assembly38.fasta` + `.fasta.fai` + `.dict`, and (for BQSR)
`Homo_sapiens_assembly38.dbsnp138.vcf.gz` + `Mills_and_1000G_gold_standard.indels.hg38.vcf.gz` (+ `.tbi`).

Two options:
- **R2 (default):** upload to the keys named in `app/api/wrangler.toml`
  (`refs/GRCh38/...`). The engine downloads the reference per case via a signed
  URL. Simple, but a ~3 GB download per WGS case.
- **Baked-in / Fly volume (recommended for WGS):** put the FASTA (+ `.fai`,
  `.dict`) on the engine and set `REFERENCE_FASTA_PATH` (and optionally
  `KNOWN_SITES_PATHS`, colon-separated) as Fly secrets/env. The engine then
  skips the per-case download. `REFERENCE_FASTA_KEY` must still be set on the
  Worker (it's the gate that allows BAM uploads).

## 2. gCNV panel-of-normals (only for CNV calling)
Run once over normal BAMs of the same assay/capture:
```
variantgpt-engine build-pon \
  --reference ref.fasta \
  --normal-bam n1.bam --normal-bam n2.bam ...   # ~20-40 normals \
  --contig-ploidy-priors priors.tsv \
  --targets exome.bed --bin-length 0 --padding 250   # omit + --bin-length 1000 for WGS
```
Upload the two outputs (`gcnv_pon.tgz`, `filtered.interval_list`) to the
`GCNV_MODEL_TGZ_KEY` / `GCNV_INTERVALS_KEY` paths in `wrangler.toml`.
`contig-ploidy-priors` is a small GATK resource you supply.

## 3. Engine image (Fly)
`engine/Dockerfile` now installs GATK, AnnotSV (+ annotation DB), samtools,
bcftools, bedtools, Java 17. Build + deploy:
```
fly deploy   # from repo root (fly.toml)
```
- The AnnotSV annotation DB (~3 GB) is downloaded during build
  (`INSTALL_ANNOTSV_DB=true`). To skip and mount it from a volume instead,
  build with `--build-arg INSTALL_ANNOTSV_DB=false` and mount the DB at
  `/opt/AnnotSV/share`.
- Confirm the `GATK_VERSION` / `ANNOTSV_VERSION` ARGs resolve (download URLs are
  version-specific).

## 4. Worker (Cloudflare)
- The R2 keys are set in `app/api/wrangler.toml [vars]` — point them at where you
  uploaded the files in steps 1–2.
- R2 CORS: `infra/r2-cors.json` already exposes `ETag` + allows `PUT` (required
  for multi-GB multipart uploads). Apply it to the `variantgpt` bucket if not
  already applied:
  `wrangler r2 bucket cors put variantgpt --rules infra/r2-cors.json`
  (restrict `origins` from `*` to your SPA origin for production).
- Deploy: `wrangler deploy` (from `app/api`).

## 5. Smoke test
Upload a small exome BAM as the proband, run a case, confirm `case.json` has
`variants` (from GATK→annotation) and — if the PON is configured —
`structural_variants` with ClinGen tiers.
