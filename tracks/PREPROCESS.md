# VCF preprocessing — what it does and why

Every uploaded VCF gets cleaned by `engine/src/variantgpt_engine/preprocess.py`
before the trio merge stage. This page is the source of truth for what
"cleaning" means here.

The same module is exposed as a CLI so you can run it locally to see
exactly what the engine will do, or to clean files before sharing them
with another tool:

```powershell
python tracks/preprocess_vcf.py --in patient.vcf --out patient.clean.vcf
```

## What gets done (single pass, in order)

| # | Step                       | What it does                                                                                                                                               | Equivalent system tool                |
|---|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------|
| 1 | Header validation          | Confirms `##fileformat`; injects a placeholder if missing. Confirms `#CHROM` line is present.                                                              | `bcftools view --header-only`         |
| 2 | Chromosome standardization | Maps `1`/`chr1`/`Chr1`/`CHR1` → `chr1` (default). `MT` → `chrM`. Configurable via `--chrom`.                                                               | `bcftools annotate --rename-chrs`     |
| 3 | Multi-allelic split        | `A,T,G` ALT becomes one record per alt allele. Per-sample GT (e.g. `0/2`) is rewritten correctly on each split record (alt-2 row gets `0/1`, alt-1 row gets `0/0`). | `bcftools norm -m -any`              |
| 4 | Allele trimming            | Strips shared prefix + suffix bases (`ATG`/`ATC` → `G`/`C`, position advanced). Required for `JointVariant` key alignment across the three VCFs.            | `bcftools norm`                       |
| 5 | Site-level QC              | Drop sites where `FILTER` is anything other than `PASS`/`.`/empty. Optional `QUAL` floor (default ≥30).                                                    | `vcftools --remove-filtered-all`      |
| 6 | Genotype-level QC          | For each per-sample call: replace GT with `./.` if **GQ < 20** or **DP < 10** or (for hets) **AB outside [0.20, 0.80]**.                                   | `bcftools filter -e 'FMT/GQ<20'`      |
| 7 | Hom-ref pruning            | Drop sites where every remaining genotype is `0/0` or `./.` — no information value for trio analysis.                                                       | `bcftools view -i 'GT[*]="alt"'`      |
| 8 | De-duplication             | Collapse exact `(chrom, pos, ref, alt)` duplicates; keep first.                                                                                            | `bcftools norm -d none`               |
| 9 | Sort                       | Output in natural chrom order (1..22, X, Y, M), then position. The merge stage assumes sorted input.                                                       | `bcftools sort`                       |

The output is a clean, normalized, sorted single-sample VCF that the
joint-merge step (`engine/joint.py`) can consume without further
preprocessing. Every output `(chrom, pos, ref, alt)` from all three
trio VCFs aligns by exact key match.

## What this module deliberately does NOT do

| Step                       | Why we skip it                                                                                                  | When you'd want it                            |
|----------------------------|-----------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| Left-align indels in repeats | Needs the reference genome FASTA on disk (~3GB). Doable as an opt-in step when `--ref` is provided.            | If your input has repeat-region indel calls and your downstream needs perfect ChAS canonical form. |
| Liftover GRCh37 → GRCh38   | Needs a chain file + reference. Belongs in a separate tool (`CrossMap`, `LiftoverVcf`).                          | If you have GRCh37 calls and want them on GRCh38 coords.                                          |
| VEP/SnpEff annotation      | The engine annotation stage already does this (CSQ from input → Ensembl VEP REST → ClinVar via myvariant.info). | If you want offline annotation before upload. |
| BAM-level QC               | We don't see the BAM. If you have access, run `gatk CalculateGenotypePosteriors` and feed the refined VCF here. | Always, for clinical-grade trios.             |

## Tuning the QC thresholds

The defaults are GATK Best Practices for clinical trio analysis. You can
override per-run:

```powershell
# Low-coverage exome — relax DP requirement
python tracks/preprocess_vcf.py --in raw.vcf --out clean.vcf --dp-min 6

# Targeted panel — tighter QC, no de-novo claims wanted on borderline calls
python tracks/preprocess_vcf.py --in raw.vcf --out clean.vcf --gq-min 30 --dp-min 20

# Trust the source — disable everything but format normalization
python tracks/preprocess_vcf.py --in raw.vcf --out clean.vcf \
  --gq-min 0 --dp-min 0 --qual-min 0 --no-drop-filtered
```

To change the engine's defaults for cloud runs, edit `PreprocessConfig`
in `engine/src/variantgpt_engine/preprocess.py` and redeploy. Manifest-
level overrides per-case are a future addition.

## How the engine reports what it did

Each `/api/cases/:id/status` log entry shows the funnel for every
member VCF, e.g.:

```
preprocess proband: proband.raw.vcf -> proband.clean.vcf
  proband: in=312488 out=4127 split=82 trimmed=216 dedup=14 dropped_filter=147
           dropped_qual=903 dropped_homref=305821 gt_gq_filtered=1240
           gt_dp_filtered=842 gt_ab_filtered=68 (4218ms)
```

Read as: input had 312k records, 4127 kept. 82 multi-allelic splits
generated. 216 alleles got prefix/suffix trimmed. 14 dupes collapsed.
147 sites dropped on the FILTER column. 903 dropped for low QUAL.
305k dropped as hom-ref (the bulk of the funnel for trio analysis —
joint callers often emit ref calls). 1240/842/68 individual calls had
GT replaced with ./. for failing per-call QC. Took 4.2s.
