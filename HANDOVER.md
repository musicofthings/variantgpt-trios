# VariantGPT — Session Handover

**Last updated:** 2026-05-28
**Working tree:** `D:\Projects\VariantGPT` (git: `musicofthings/variantgpt-trios`, branch `main`)
**Specs:** [`VariantGPT_PRD_TRD.md`](VariantGPT_PRD_TRD.md) · [`VariantGPT_Frontend_Design_Spec.md`](VariantGPT_Frontend_Design_Spec.md)
**Deploy:** [`infra/DEPLOY.md`](infra/DEPLOY.md)

---

## TL;DR — what's live right now

A fully functional production deploy on Cloudflare + Fly with the entire SPA→Worker→Engine→case.json pipeline running end-to-end on real clinical WGS trio VCFs (~180k variants per sample → ~8.5k rare candidate variants surfaced).

```
Cloudflare Pages (variantgpt-web)                 ← React SPA (Vite + TS)
   │ /api/*
Cloudflare Worker (variantgpt-api, Hono)          ← edge surface
   ├── D1   (cases, members, jobs, uploads)
   ├── R2   (VCFs, case.json, cache stages)
   └── Fly.io machine (variantgpt-engine, 8GB)    ← Python engine via HTTP
                                                    (tracks/container_server.py)
```

### Verified runs

| Case | Trio VCFs | Candidates surfaced | Reclassified | HPO matches | Runtime (caches warm) |
|---|---|---|---|---|---|
| Demo trio (`demo-trio-001`) | seeded | 11 | 1 (MEFV via IndiGen BS1) | n/a | ~600 ms |
| `case-mpmgha8k` (Apollo proband) | 187k / 185k / 185k joint variants | 8454 | 172 | 438 / 8454 across 3 case HPO terms | ~10 min (IndiGen sweep dominates) |

The Apollo lab report's three clinical variants (TRIO p.His831Tyr, SRRM2 p.Asn22Ser, GJB2 p.Trp24Ter) are correctly surfaced with full HGVS / exon / OMIM / ClinVar / ACMG strength annotation.

---

## What works (current feature set)

### Home → Pipeline → Intake → Workbench → Report

- **Home** (`/`) — VariantGPT brand + three pipeline cards (Singleton / Duo / Trio, trio recommended) + Cases / Tracks tiles.
- **Intake** (`/cases/new?mode=…`) — pedigree (seeded from mode), HPO typeahead (EBI OLS4-backed), clinical history block (onset age / consanguinity / family history / prior testing / free-text), VCF dropzones with in-browser header sniff (sample name, build), R2 presigned-PUT upload, engine run trigger, live run monitor with log tail.
- **Workbench** (`/cases/:id`) — inheritance tabs (All / De novo / Comp het / Recessive / Dominant / Het inherited / X-linked / Reclassified), faceted tier filter with live counts, **"Phenotype match only"** chip (HPO gene-match filter), sortable columns, row checkboxes for report inclusion, sticky drawer per variant with the **Clinical Card** (lab-report-style fielded layout: gene, transcript, exon, HGVS c./p., genomic, consequence, inheritance + confidence, OMIM, HPO matches, ClinVar with stars + conditions, ACMG fired criteria with strength tokens, classification), family-call table (zygosity / depth / AB / GQ), evidence ledger, population-AF lollipop, predictor gauges. Mobile-responsive layout.
- **Report** (`/cases/:id/report?variants=…`) — print-grade clinical report.
  - **Page 1**: cover, case summary, **Patient details** (proband ID / sample / sex / affected status / onset age / consanguinity / family history / prior testing), **Clinical history** (free-text), **HPO terms** table (id + label), selected findings summary, reclassification decisions, methods & limitations, signatory.
  - **Pages 2…N** (one per selected variant): full clinical detail — Clinical variant summary, **Gene** prose paragraph, **Variant findings & phenotype relevance** prose paragraph + per-HPO-term context lines, family genotype calls, **fired-only ACMG evidence** (not-fired rows dropped), population AFs, predictors, reclassification decision block.
  - **Print/PDF**: `@media print` in `global.css` strips app shell (sidebar, topbar, drawer, all buttons), flattens cards, applies `@page A4` margins, forces page breaks per variant, renders chips as bordered text. Browser print preview is now clean white paper.

### Engine pipeline

Orchestrated by [`tracks/container_server.py`](tracks/container_server.py). Stages, each cache-resumable in R2:

1. **VCF preprocess** ([engine/preprocess.py](engine/src/variantgpt_engine/preprocess.py)) — 9-step cleanup: header validation, chrom normalization, multi-allelic split, allele trim, site QC (FILTER ≠ PASS dropped), GT-level QC (GQ ≥ 20, DP ≥ 10, AB 0.20–0.80), hom-ref prune, dedup, sort.
2. **Joint merge + trio QC** — GATK-style per-call grading for de-novo confidence (HIGH → PS2, MEDIUM → PM6, LOW → not fired).
3. **Proband-carrier filter** — drops sites where the proband isn't a carrier (~30× reduction).
4. **Rare-variant filter** — gnomAD v4 AF < 1% via batched myvariant.info AF lookup (10-way concurrent).
5. **VEP REST annotation** — payload flags `{hgvs, numbers, mane, canonical, protein, symbol, domains}`; concurrent batches; extracts HGVS c./p., MANE transcript, exon, consequence.
6. **myvariant.info batch** — ClinVar (significance / review_stars / conditions / variation_id) + dbNSFP (AlphaMissense / REVEL / CADD / SpliceAI) + gnomAD AF.
7. **IndiGenomes live API** — IGIB `data.php` queried per gene via Cloudflare Worker proxy (`/api/internal/indigen-proxy`) since Fly IPs are blocked by IGIB. MAX_GENES_PER_CASE=400, priority-sorted, 15s per-batch timeout, ANNOVAR↔VCF allele representation conversion for indel matching.
8. **mygene.info** — gene-level OMIM IDs.
9. **HPO matching** ([annotation_sources/hpo_genes.py](engine/src/variantgpt_engine/annotation_sources/hpo_genes.py)) — downloads HPO consortium `genes_to_phenotype.txt` (~20 MB, 329k mappings), matches each variant's gene against case HPO terms; sets `v.hpo_matches` and boosts `priority_score`.
10. **ACMG classify** ([acmg/criteria.py](engine/src/variantgpt_engine/acmg/criteria.py)) — Tavtigian point system; criteria implemented: PVS1, PS1, PS2, PM1, PM2, PM4, PM5, PM6, PP3, BA1, BS1, BS2, BP4, BP7.
11. **South-Asian reclassification** ([reclassify.py](engine/src/variantgpt_engine/reclassify.py)) — `SAS_SOURCES = ("indigenomes", "genomeasia", "genomeindia")`. gnomAD-SAS deliberately excluded (not representative of Indian population). PM2 retracted / BS1 fired on highest-AF Indian source.

### Inheritance models

`InheritanceModel` ([models.py](engine/src/variantgpt_engine/models.py)) includes: `de_novo`, `ar_hom`, `comp_het`, `ad_inherited`, **`het_inherited`** (proband het transmitted from unaffected parent — most rare hets; was previously dumped to "unresolved"), `x_linked_recessive`, `x_linked_dominant`, `y_linked`, `mitochondrial`, `unresolved`.

### Caching / resume

R2 stage caches keyed by versioned URLs:
- `af_map` — myvariant.info AF lookup
- `csq_v2` — VEP REST annotation
- `variants_v6` — annotate + classify + HPO (current; bumped from v5 when `het_inherited` was added)

A failed/OOM run resumes from the last completed chunk; only the bumped stage rebuilds.

### Auth (scaffold)

`@clerk/clerk-react` integrated in [`app/web/src/auth.tsx`](app/web/src/auth.tsx):
- `AuthGate` wraps `<App>`; when `VITE_CLERK_PUBLISHABLE_KEY` is set, signed-out users hit Clerk's hosted sign-in.
- `UserChip` in sidebar (avatar + name + sign-out).
- **Fallback:** if no Clerk key set, AuthGate is a pass-through with a "dev mode" badge so local dev / unauthenticated previews keep working.
- **Not yet wired:** Worker-side JWT validation against Clerk JWKS. Right now the SPA gates the UI; anyone with the Worker URL can hit `/api/*` directly.

---

## File map of recent work

```
engine/src/variantgpt_engine/
  models.py                              InheritanceModel + het_inherited; HPOTerm.label
                                         coerce_numbers_to_str on ClinVarRecord
  preprocess.py                          VCF cleaner (9-step)
  filter.py                              proband_carrier_filter + AF/consequence filter
  inheritance.py                         het_inherited classification logic
  reclassify.py                          SAS_SOURCES = indigenomes/genomeasia/genomeindia
  cache.py                               R2 stage cache helpers
  annotation.py                          per-member call projection
  annotation_sources/
    csq.py                               EXON, MANE-preferred transcript
    vep_rest.py                          REST flags + concurrent batches
    myvariant.py                         batched ClinVar + dbNSFP + gnomAD
    indigenomes.py                       live IGIB data.php client
    mygene.py                            OMIM gene lookup
    hpo_genes.py                         genes_to_phenotype catalog + match_gene
    clinvar.py                           ClinVar VCF tabix-over-HTTP (legacy path)

tracks/
  container_server.py                    Pipeline orchestrator (Fly engine entrypoint)

app/api/src/
  routes/api.ts                          /api/* surface; cache_urls (af_map, csq_v2, variants_v6);
                                         IndiGen proxy /api/internal/indigen-proxy

app/web/src/
  App.tsx                                AuthGate wrap; new route layout (/, /cases, /cases/new)
  auth.tsx                               Clerk integration with dev-mode fallback
  caseData.ts                            adaptCase returns hpo + clinical_history + proband_member
  pages/
    Home.tsx                             NEW — pipeline picker landing screen
    Dashboard.tsx                        case list (moved to /cases)
    Intake.tsx                           clinical-history fields (4 inputs + textarea); ?mode= pedigree
    Workbench.tsx                        het_inherited tab; HPO match filter; phenotype chip;
                                         Clinical Card drawer with HPO chips
    Report.tsx                           Patient details + Clinical history + HPO table; per-variant
                                         pages with gene/variant prose, fired-only ACMG, family calls
  styles/global.css                      @media print clinical-report styles
  types.ts                               hpo_matches, het_inherited
  types-pedigree.ts                      DEFAULT_SINGLETON / DUO / TRIO + pedigreeForMode()

infra/
  DEPLOY.md                              first-time deploy playbook
  migrations/0001_init.sql               cases / members / evidence
  migrations/0002_jobs_and_uploads.sql   jobs + uploads

fly.toml                                 shared-cpu-4x, 8192 MB, min_machines_running=1
.github/workflows/deploy.yml             engine → api → web ordered deploy
```

---

## Known gaps / road ahead

1. **CI lint failures on `tests/test_preprocess.py`** (E702, E741) — pre-existing, unrelated to current features. Doesn't block `deploy` job which is on a separate workflow. Trivial fix when convenient.
2. **GenomeAsia 100K integration** — task #35, deferred. IndiGen handles bulk of Indian-population coverage; GenomeAsia would round it out for non-Indian South-Asian ancestry. AF schema is already shape-compatible.
3. **Clerk Worker-side JWT validation** — see auth scaffold above. Add `verifyToken` middleware on `/api/*` that hits Clerk JWKS once and caches.
4. **Singleton/duo banner in Workbench** — engine already degrades de novo → PM6 → none based on QC; would be nice to surface "Singleton mode: PS2 unavailable; PM6 max Moderate" so curators don't wonder why a clear de novo isn't fired.
5. **Path-filter CI** — task #31. Previous attempt failed (GHA silently rejected the workflow file). Engine + api + web jobs currently all run on every push; not blocking but noisy.
6. **CNV/SV/mitochondrial heteroplasmy** — out of scope per PRD §1.
7. **bcftools / tabix / cyvcf2** — pure-Python engine intentionally avoids these so it runs on Fly without htslib. Real WGS multi-allelic VCFs work via the in-house preprocess.

---

## Resume commands

```bash
# Trigger a rerun on an existing case (caches warm, faster)
curl -X POST https://variantgpt-api.shibi-kannan.workers.dev/api/cases/<caseId>/rerun

# Tail engine status
curl -s https://variantgpt-api.shibi-kannan.workers.dev/api/cases/<caseId>/status | jq

# Local dev (no Cloudflare)
cd app/web && npm run dev

# Force rebuild of demo case
python tracks/build_demo_case.py
```

### Required env vars (Cloudflare Pages)

```
VITE_API_BASE              https://variantgpt-api.shibi-kannan.workers.dev
VITE_CLERK_PUBLISHABLE_KEY pk_test_...   (optional — leave unset for dev-mode pass-through)
```

### Required Worker secrets

`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `ENGINE_CALLBACK_SECRET`, `INDIGEN_PROXY_BEARER`, `FLY_ENGINE_URL`.

---

## Session log

### 2026-05-28 — Report polish + UX home/pipelines
- Report: dropped not-fired evidence rows; added gene paragraph + variant-with-phenotype paragraph + per-HPO-term context line; new **Patient details**, **Clinical history**, **HPO terms** sections on page 1.
- Intake: added Consanguinity notes + Family history inputs; structured `clinical_history` block in manifest; HPO sent as `{id,label}` so labels survive the round-trip.
- New `Home.tsx` page with Singleton/Duo/Trio picker; Dashboard moved to `/cases`.
- `types-pedigree.ts`: `DEFAULT_SINGLETON`, `DEFAULT_DUO`, `pedigreeForMode()`.
- Clerk OAuth scaffold (`@clerk/clerk-react`) — pass-through when key absent.

### 2026-05-27 — HPO matching, het_inherited, report v2
- HPO consortium `genes_to_phenotype` catalog loaded in engine; per-variant `hpo_matches`; SPA filter chip + drawer rows.
- New `het_inherited` inheritance model — most rare hets had been falling into "unresolved".
- Clinical Card drawer rebuilt to lab-report fielded layout (matches Apollo PDF).
- Report restructured to cover page + per-variant detail pages with `@media print` clinical layout.
- Variants cache key bumped v4 → v5 → v6 over the session as schema evolved.

### 2026-05-26 — IndiGen live API, performance, engine sizing
- Pivoted IndiGen from static R2 dump to live `data.php` API via Cloudflare Worker proxy (IGIB blocks Fly IPs).
- ANNOVAR↔VCF allele representation fix for indel matching (was getting 70/151 hits; now full).
- Removed per-variant synchronous gnomAD call from `annotate()` — 60s/chunk bottleneck. Replaced with batched myvariant.info AF.
- Fly machine: shared-cpu-4x / 8 GB / `min_machines_running=1`. Killed auto-stop.
- Pipeline checkpoint/resume in R2 — failed runs no longer lose AF / VEP work.
- UI: sortable columns, faceted tier filter with counts, row checkboxes, sticky drawer, working Generate Report button, mobile responsive.

### 2026-05-25 — Cloudflare deploy port + code review fixes
- Wired the production deploy: Pages + Workers + D1 + R2 + Fly engine.
- HMAC-signed engine callbacks; per-case container instances; presigned R2 PUT uploads.
- Top-5 code review fixes (path traversal, BS1 multi-fire, reclass_points math, inflight map cleanup, upload size cap).
- Engine `use_demo_annotations` fallback for offline runs.

### Pre-2026-05-25 — Engine scaffold + frontend
- Pure-Python VCF reader, joint merge, inheritance modeling, ACMG point classifier, South-Asian reclassification.
- Full design-system frontend: TierChip, ReclassBadge, EvidenceLedger, PopulationFreqPanel, PredictorGauges, Pedigree, FileDropzone, RunMonitor.
- Curated demo dataset (11 real ClinVar variants) + trio VCF generator + demo case runner.

---

## Spec deviations / decisions logged

1. **Baseline ACMG uses gnomAD-global only** (PM2/BA1/BS1) — so the SAS reclassification step has something to do. Spec §4.6 implies this split.
2. **South-Asian reclassification excludes gnomAD-SAS** — Indians are underrepresented in gnomAD-SAS (largely Korean/Chinese). IndiGenomes + GenomeAsia + GenomeIndia only.
3. **Per-variant synchronous gnomAD lookup removed** — was the real `annotate()` bottleneck (60 s/chunk). Redundant with batched myvariant.info AF.
4. **Fly.io for engine instead of Cloudflare Containers** — Containers beta hit memory ceilings; Fly gives 8 GB shared-cpu-4x at predictable cost.
5. **IndiGen via Worker proxy** — Fly IPs blocked by IGIB. Worker has 7-day edge cache.
6. **HPO catalog downloaded fresh per Fly machine lifetime** — cached at `/tmp/variantgpt/g2p.txt`; 20 MB, 329k mappings, parses in ~2 s.
7. **`het_inherited` instead of "unresolved" for most rare hets** — labeling the AR-carrier / single-hit / low-penetrance-AD bucket explicitly is more clinically useful than dumping them all to "unresolved".
8. **Print stylesheet flattens chips to bordered text** — better B&W print + saves toner. Color tier chips stay on screen.
9. **Clerk auth has a dev-mode pass-through** — unblocks local dev / preview deploys until the user provisions Clerk.
