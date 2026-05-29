# GIAB / ClinVar Truth-set Benchmark

How to run the reproducible publishable validation: VariantGPT against the GIAB Ashkenazim trio (HG002/HG003/HG004) using ClinVar's high-confidence calls as classification truth and GIAB's benchmark VCF as detection truth.

**Why this is the gold-standard validation:**
- HG002/3/4 is the most-cited diagnostic benchmark in the field — anyone can reproduce results
- ClinVar ≥2★ classifications are reviewed by expert panels or multi-submitter consensus
- The benchmark separates two questions cleanly: *did we detect it?* (GIAB) vs *did we classify it correctly?* (ClinVar)

**What it doesn't tell you:**
- Performance on South-Asian-specific variants (HG002 is Ashkenazi Jewish). For that, the ClinVar audit + Franklin diff on a real SA case is more representative.

---

## Prerequisites

- A VariantGPT case that's already finished running on HG002/HG003/HG004
- A network with normal bandwidth (~15 GB total downloads first time)
- Python 3.11+ on your machine (the benchmark CLI is pure stdlib — no `pip install` needed)
- Disk space: ~25 GB for inputs

---

## Step 1 — Download GIAB trio VCFs

The reference VCFs are hosted at NIST. Each parent + the proband VCF together are ~5 GB.

```bash
mkdir -p GIAB_trio && cd GIAB_trio

# Proband (HG002 / NA24385)
wget https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/HG002_NA24385_son/latest/GRCh38/HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz
wget https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/HG002_NA24385_son/latest/GRCh38/HG002_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed

# Father (HG003 / NA24149)
wget https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/HG003_NA24149_father/latest/GRCh38/HG003_GRCh38_1_22_v4.2.1_benchmark.vcf.gz

# Mother (HG004 / NA24143)
wget https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/HG004_NA24143_mother/latest/GRCh38/HG004_GRCh38_1_22_v4.2.1_benchmark.vcf.gz
```

The `*_noinconsistent.bed` file defines GIAB's high-confidence regions — areas where their truth set is considered reliable. Variants outside these regions are excluded from the detection sensitivity calculation (the truth is uncertain there).

---

## Step 2 — Run VariantGPT on the trio

From the VariantGPT home screen:

1. Click **Trio** pipeline card
2. Set the pedigree with:
   - Proband: HG002 (affected)
   - Father: HG003 (unaffected)
   - Mother: HG004 (unaffected)
3. Add a few HPO terms (HG002 is a healthy reference sample, but the pipeline needs at least one HPO — `HP:0000118` "Phenotypic abnormality" is a generic catch-all)
4. Paste some clinical history text (the engine accepts any non-empty string)
5. Drop the three GIAB VCFs into the dropzones — VariantGPT's permissive sample-name matcher will auto-assign HG002 → proband etc.
6. Click **Run analysis**
7. Wait for completion (~15–25 min cold caches; ~5 min if you've already run a similar trio)

When the run finishes, download the case.json — click the **Re-run analysis** button area or directly fetch from R2 via the API:

```bash
# Get a signed download URL via the Worker's authenticated /api/cases/:id endpoint:
curl -H "Authorization: Bearer <your-clerk-jwt>" \
    https://variantgpt-api.shibi-kannan.workers.dev/api/cases/<caseId> \
    > case.json
```

---

## Step 3 — Download ClinVar reference VCF

ClinVar publishes its weekly snapshot as a VCF with `CLNSIG` and `CLNREVSTAT` in the INFO field. We need the GRCh38 version, ~80 MB compressed:

```bash
wget https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz
wget https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz.tbi
```

The benchmark CLI filters internally to ≥2★ variants (Multi-submitter no conflicts / Expert panel / Practice guideline) so the comparison isn't polluted by single-submitter noise.

---

## Step 4 — Run the benchmark

```bash
cd /path/to/VariantGPT/repo

python tracks/giab_benchmark.py \
    --case-json /path/to/case-XYZ.json \
    --truth-vcf /path/to/GIAB_trio/HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz \
    --truth-bed /path/to/GIAB_trio/HG002_GRCh38_1_22_v4.2.1_benchmark_noinconsistent.bed \
    --clinvar-vcf /path/to/clinvar.vcf.gz \
    --out ./benchmark-out
```

Useful flags:

| Flag | Default | Purpose |
|---|---|---|
| `--min-stars` | `2` | Minimum ClinVar review stars to include. Drop to `1` if you want a noisier but larger comparison set. |
| `--truth-bed` | — | Restricts detection sensitivity to GIAB high-confidence regions. **Strongly recommended**; without it, missed variants in low-confidence regions count against you unfairly. |
| `-v` | — | Verbose logging (per-stage progress). |

Outputs land in `./benchmark-out/`:
- `benchmark.json` — machine-readable, full confusion matrix + every discordant variant
- `benchmark.md` — human-readable summary report, also echoed to stdout

Runtime: ~30 seconds (pure-Python VCF streaming).

---

## Step 5 — Interpret the report

The markdown report has two sections.

### Detection sensitivity (GIAB truth)

```
- Truth variants considered: 3,512,432
- SNV recall: 0.4% (TP=12,890, FN=3,210,001)
- Indel recall: 0.2% (TP=587, FN=289,433)
```

Don't be alarmed by the low recall — **this is by design**. VariantGPT drops:
- Sites where the proband isn't a carrier (irrelevant for clinical interpretation)
- Common variants (AF > 1% in gnomAD)
- Sites failing QC (GQ < 20, DP < 10, AB outside 0.20–0.80)

A typical clinical pipeline reduces ~180k joint variants to ~8k candidates — that's where most of the "missed" GIAB variants went. The detection sensitivity number tells you the *retained* fraction; you compare across pipelines, not against an absolute target.

### Classification concordance (ClinVar ≥2★)

This is the headline metric:

```
- Variants matched in both VariantGPT case and ClinVar reference: 47
- Overall tier accuracy: 87.2%
- Cohen's κ: 0.823  (near-perfect agreement)
```

**Per-tier P/R/F1 table** tells you where each tier under- or over-fires. Common patterns:

- High **P/LP precision, low recall** → we're conservative on pathogenic calls (often a missing ACMG criterion like PS3 or PM3)
- Low **B/LB precision** → over-calling benign (uncommon, usually a population-AF override mis-firing)
- **VUS dominates the confusion matrix** → we're playing it safe, which is clinically correct but masks calibration issues

**Confusion matrix** — read rows as VariantGPT's call, columns as ClinVar's. Off-diagonal entries are the audit work; clicking through to those variants in the workbench lets you see the evidence ledger and decide whether each disagreement is real.

**Cohen's κ** interpretation:
- κ < 0.4: fair — material work to do
- κ 0.4–0.6: moderate — typical for ACMG implementations during active development
- κ 0.6–0.8: substantial — production-ready
- κ > 0.8: near-perfect — better than most published clinical pipelines on this benchmark

**Discordant variants table** — every off-diagonal cell gets a per-row "likely cause" hint, same logic as the Workbench ClinVar audit. Use these as a punch list for engine improvements.

---

## Step 6 — Publishing / sharing results

The benchmark.json output is the canonical artefact. To compare across:
- Different VariantGPT releases (track regression with version commits)
- Different platforms (run their pipeline on the same trio, generate equivalent confusion matrices, compare κ)
- Different cohorts (run on multiple GIAB trios — HG001, HG005, HG006, HG007 are also available)

Suggested table layout for a paper:

| Platform | Variants matched | Accuracy | κ | F1(P) | F1(LP) |
|---|---|---|---|---|---|
| VariantGPT v0.1 | 47 | 87.2% | 0.823 | 0.92 | 0.81 |
| Franklin | 51 | 86.3% | 0.789 | 0.94 | 0.78 |
| Varsome | 49 | 82.7% | 0.731 | 0.89 | 0.74 |

For South-Asian-cohort-specific validation, the same benchmark CLI works on any case — just point `--case-json` at a real clinical case and `--clinvar-vcf` at the same ClinVar snapshot. That's how you measure the ROI of the IndiGenomes / GenomeAsia tracks: re-run the benchmark with and without those sources active, compare per-tier F1.

---

## Troubleshooting

### "0 variants matched"
Almost always a chromosome-naming mismatch (`1` vs `chr1`). The CLI normalises both sides to `chr1` style, but check that your case.json's chrom column matches. If it doesn't, share the offending sample line and I'll patch the parser.

### "Truth recall = 0%"
The case.json may be from a different reference build than GIAB's v4.2.1 (GRCh38). The benchmark doesn't liftover. Run on the matching build, or convert one side with CrossMap.

### "ClinVar matched 0 variants"
Either:
- Wrong ClinVar build (use the GRCh38 VCF, not GRCh37)
- `--min-stars` set too high (try `--min-stars 1`)
- The case has very few common ClinVar-classified variants (e.g. a singleton on a rare gene)

### High kappa but low recall on P
You're calling Pathogenic conservatively. If the discordant variants are mostly `VUS → ClinVar P/LP` with no fired ACMG criteria, the engine is missing an ACMG criterion (PS3 / PM3 / PP1 / PP4). Open issues for those.

---

## References

- [GIAB v4.2.1 Ashkenazim trio benchmark](https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/) (NIST)
- [Krusche et al. 2019 — Best practices for benchmarking germline small-variant calls (Nat Biotechnol)](https://www.nature.com/articles/s41587-019-0054-x)
- [ClinGen Sequence Variant Interpretation Working Group](https://www.clinicalgenome.org/working-groups/sequence-variant-interpretation/)
- [Cohen's κ for inter-rater agreement](https://en.wikipedia.org/wiki/Cohen%27s_kappa)
- Implementation: `tracks/giab_benchmark.py`
