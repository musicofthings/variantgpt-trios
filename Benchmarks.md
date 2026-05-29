# VariantGPT — Benchmark Results

This file is where the numbers from the three validation layers live, both as a public record and as a regression baseline. **Update on every meaningful engine change** (new ACMG criterion, new population AF source, threshold rebalance, etc.) by re-running the relevant benchmark and appending a new row.

For methodology see:
- [GIAB_benchmark.md](GIAB_benchmark.md) — how to run the truth-set benchmark (Validation C)
- [GenomeAsia_config.md](GenomeAsia_config.md) — how to activate the GenomeAsia AF source
- Source: [`tracks/giab_benchmark.py`](tracks/giab_benchmark.py)

---

## 1. GIAB / ClinVar truth-set benchmark

**Setup:** VariantGPT trio run on GIAB Ashkenazim trio (HG002 proband / HG003 father / HG004 mother), GRCh38, default pipeline settings. Detection sensitivity computed on GIAB v4.2.1 truth VCF restricted to high-confidence regions (BED). Classification concordance computed against ClinVar weekly snapshot, restricted to ≥2★ review status (multi-submitter no conflicts / expert panel / practice guideline).

### Headline metrics

| Run date | Engine commit | n matched (ClinVar) | Accuracy | Cohen's κ | F1(P) | F1(LP) | F1(VUS) | F1(LB) | F1(B) | SNV recall | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| _TBD_ | _abc1234_ | — | —% | — | — | — | — | — | — | —% | First baseline once user uploads GIAB trio |

> **How to add a row:** Run the benchmark per `GIAB_benchmark.md`. Paste the values from `benchmark.md` here. Link to the full `benchmark.json` if you want it archived (commit it under `data/benchmarks/<date>/`).

### Confusion matrix (latest run)

Rows = VariantGPT tier (post South-Asian reclassification); Columns = ClinVar tier.

| Ours \ ClinVar | P | LP | VUS | LB | B |
|---|---|---|---|---|---|
| **P** | — | — | — | — | — |
| **LP** | — | — | — | — | — |
| **VUS** | — | — | — | — | — |
| **LB** | — | — | — | — | — |
| **B** | — | — | — | — | — |

> Replace dashes with counts from the latest `benchmark.md`.

### Per-tier breakdown (latest run)

| Tier | TP | FP | FN | Precision | Recall | F1 |
|------|----|----|----|-----------|--------|----|
| **P**   | — | — | — | — | — | — |
| **LP**  | — | — | — | — | — | — |
| **VUS** | — | — | — | — | — | — |
| **LB**  | — | — | — | — | — | — |
| **B**   | — | — | — | — | — | — |

### ROI of South-Asian AF sources

Run the benchmark twice on the same case — once with all SAS sources active (IndiGen / GenomeAsia), once with them deactivated — to quantify what those tracks buy you.

| Source set | n matched | Accuracy | κ | F1(P) | F1(B) |
|---|---|---|---|---|---|
| gnomAD only (baseline) | — | —% | — | — | — |
| + IndiGenomes | — | —% | — | — | — |
| + GenomeAsia 100K | — | —% | — | — | — |
| + GenomeIndia | — | —% | — | — | — |

> Useful only on a South-Asian case — HG002/3/4 (Ashkenazi Jewish) won't surface SA-specific reclassifications.

### Discordant variants — engine-improvement punch list (latest run)

Pulled directly from the discordant-variants table in `benchmark.md`. Each row that lands here is a concrete engine task: either add a missing ACMG criterion or rebalance a threshold.

| Gene · HGVS | Ours | ClinVar | Likely cause | Action item |
|---|---|---|---|---|
| _example: ATM c.5932G>T_ | _VUS_ | _LP (3★)_ | _Fired PP3 but no other pathogenic criteria — likely missing PS3 (functional studies in literature)_ | _Add PS3 adapter against MAVE-DB / functional curation_ |

> Append rows as you investigate each discordant case. When an engine fix lands and the next benchmark run shows it's resolved, prefix the row with `~~strikethrough~~` and add the commit SHA in a Notes column.

---

## 2. Franklin (Genoox) cross-platform diff

**Setup:** Same case run on both Franklin (via their hosted SPA, default settings) and VariantGPT. Variants joined by (chr, pos, ref, alt). Franklin's "Uncertain — Possibly Pathogenic (Moderate)" sub-flavors collapsed to VUS for tier comparison.

> **Calibration caveat:** Franklin uses GenomeAsia 100K internally for South-Asian classification. Until VariantGPT's GenomeAsia track is activated, expect a systematic bias against us in the BOTH_DIFFER / FRANKLIN_ONLY buckets on SA-common variants — *not* an ACMG implementation gap.

### Per-case results

| Case ID | Date | n in both | Concordance | BOTH_DIFFER | FRANKLIN_ONLY | VARIANTGPT_ONLY | Notes |
|---|---|---|---|---|---|---|---|
| _e.g._ `case-mpmgha8k` | _2026-05-28_ | — | —% | — | — | — | _Pre-GenomeAsia baseline_ |
| _same case_ | _post-GA100K activation_ | — | —% | — | — | — | _Delta vs baseline shows GA100K ROI_ |
| `Master Adrij Bangal` | _2026-05-29_ | — | —% | — | — | — | _252 variants in Franklin export; first SA case run_ |

> Pull these from the Franklin diff page header. Screenshot the page if you want a visual record.

### Common divergence patterns

Track which categories of disagreement keep recurring so we know what to prioritise:

| Pattern | Frequency | Likely root cause | Action |
|---|---|---|---|
| Franklin LP, VariantGPT VUS, ClinVar absent | _N_ | Missing PS3 / PM3 / PP1 / PP4 criterion | Implement criterion |
| Franklin VUS, VariantGPT LB (post-reclass) | _N_ | IndiGenomes BS1 fires correctly; Franklin doesn't have IndiGen | Expected behavior — this is the SA-aware win |
| Franklin keeps, VariantGPT filters | _N_ | gnomAD AF > 1% (we drop common); Franklin's threshold tighter | Confirm our 1% cutoff is the spec |

---

## 3. ClinVar audit — production case snapshots

The Workbench's ClinVar audit panel auto-computes per-case concordance every time a case is opened. Snapshot here whenever you want a record (e.g. after a meaningful engine change).

### Per-case audit results

| Case ID | Date | n with ≥2★ ClinVar | Concordance rate | Missed P/LP | Over-called | Notes |
|---|---|---|---|---|---|---|
| `case-mpmgha8k` | _2026-05-28_ | _N_ | —% | _N_ | _N_ | _8454 candidate variants; pre-GenomeAsia_ |

> Click "ClinVar audit" on the Workbench → the header line has these counts ready to paste.

---

## 4. Cross-platform comparison (publishable format)

When you've run all three platforms on the same trio with the same ClinVar reference, this is the table that goes in a paper or a poster:

| Platform | n matched | Accuracy | Cohen's κ | F1(P) | F1(LP) | F1(VUS) | F1(B) |
|---|---|---|---|---|---|---|---|
| **VariantGPT** v0.1 (gnomAD only) | — | —% | — | — | — | — | — |
| **VariantGPT** v0.1 + IndiGen | — | —% | — | — | — | — | — |
| **VariantGPT** v0.1 + IndiGen + GA100K | — | —% | — | — | — | — | — |
| Franklin / Genoox | — | —% | — | — | — | — | — |
| Varsome | — | —% | — | — | — | — | — |
| InterVar | — | —% | — | — | — | — | — |

> Reproducibility note: archive the ClinVar VCF used (it changes weekly), the GIAB benchmark version (v4.2.1 as of writing), and the VariantGPT engine commit so the row is anchored to a specific snapshot.

---

## How to keep this file honest

- **One row per release.** Tag engine changes with a git tag (`v0.2`, `v0.3`); the row's commit column points to the tag.
- **Don't cherry-pick cases.** Run the benchmark on the *same* case across releases. The point is to see drift over time, not to chase the best individual number.
- **Archive the raw output.** If you publish a row, commit the underlying `benchmark.json` alongside it so the calculation is auditable later.
- **Surface regressions.** If a metric drops (κ goes down, F1(P) falls), open an issue with the discordant-variant table from that run.

---

## Future benchmarks

- **More GIAB cohorts**: HG001 (Utah), HG005/6/7 (Han Chinese trio) — adds ancestry breadth
- **MELT** (Maximizing Established disease-Linked Tests) — a curated set of well-known ACMG benchmark variants
- **CSPEC / VCEP-specific cohorts** — gene-specific calibration once we implement gene-tailored AF thresholds
- **Inter-rater study** — pass the same VUS to N curators in the app, measure inter-rater agreement on our evidence ledger vs Franklin's
