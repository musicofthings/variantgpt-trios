# VariantGPT — Session Handover

**Last updated:** 2026-05-25
**Working tree:** `D:\Projects\VariantGPT` (no git yet)
**Specs:** [`VariantGPT_PRD_TRD.md`](VariantGPT_PRD_TRD.md) · [`VariantGPT_Frontend_Design_Spec.md`](VariantGPT_Frontend_Design_Spec.md)

## TL;DR — what works right now

A fully functional **local-dev** vertical slice:

```
┌─ SPA (Vite dev :5173) ───────────────────────────────────────────────┐
│  Dashboard  ─→  New case (Intake)  ─→  Run analysis  ─→  Workbench  │
│       ↑                ↓                     ↓                       │
│       └─ active runs ──┴──── RunMonitor (live log) ──────────────────┘
└──────────────────────────────────────────────────────────────────────┘
              │
              │ /api/uploads · /api/cases · /api/cases/:id · /status
              ▼
┌─ Vite dev middleware (app/web/vite.devCaseApi.ts) ───────────────────┐
│   stand-in for the Cloudflare Workers API (PRD §6.6)                 │
│   • POST /api/uploads/:caseId/:role   → data/uploads/<id>/<role>.vcf │
│   • POST /api/cases/:caseId/run       → spawns engine                │
│   • GET  /api/cases/:caseId/status    → live job state + log         │
│   • GET  /api/cases                   → list (active + history)      │
│   • GET  /api/cases/:caseId           → case.json                    │
└──────────────────────────────────────────────────────────────────────┘
              │
              │ python tracks/run_uploaded_case.py <caseId>
              ▼
┌─ Python engine (engine/src/variantgpt_engine/) ──────────────────────┐
│   pure-Python VCF parse → joint merge → inheritance → annotation     │
│   → ACMG point classifier → South Asian reclassification → case.json │
└──────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
# Engine deps (Python 3.11+ required by pyproject; 3.14 also works for the slice)
cd engine && pip install -e .[dev]

# Frontend
cd ../app/web && npm install && npm run dev          # → http://localhost:5173

# (Optional) rebuild the seeded demo case
python tracks/build_demo_vcfs.py
python tracks/build_demo_case.py                     # → app/web/public/demo/case.json
```

Open http://localhost:5173 — the demo trio loads from `/demo/case.json`.

## What's been built (this session)

### Frontend (React + TS, Vite, Cloudflare Pages target)
- **Design system** ([styles/tokens.css](app/web/src/styles/tokens.css), [global.css](app/web/src/styles/global.css)) — full spec §2 implementation: warm-paper palette, colorblind-safe ACMG tier chips, Fraunces/Public Sans/JetBrains Mono pairing
- **Components**
  - [`TierChip`](app/web/src/components/TierChip.tsx) — letter token + color + (optional) strength
  - [`ReclassBadge`](app/web/src/components/ReclassBadge.tsx) — `from → to Δ±n` sienna pill
  - [`EvidenceLedger`](app/web/src/components/EvidenceLedger.tsx) — two-column Pathogenic/Benign, fired vs muted, expandable trigger/source
  - [`PopulationFreqPanel`](app/web/src/components/PopulationFreqPanel.tsx) — lollipop bar across gnomAD-global/SAS/IndiGenomes/GenomeAsia/(GenomeIndia) w/ BA1/BS1 threshold line
  - [`PredictorGauges`](app/web/src/components/PredictorGauges.tsx) — AlphaMissense/REVEL/CADD/SpliceAI with ClinGen-calibrated PP3 thresholds
  - [`Pedigree`](app/web/src/components/Pedigree.tsx) — interactive trio default, click-to-select node editor (sex / affected / **no-sample** / remove), add father/mother/sibling, consanguinity
  - [`FileDropzone`](app/web/src/components/FileDropzone.tsx) — drag/drop VCF/.gz/BAM, type+size badges, soft-warning >10GB
  - [`RunMonitor`](app/web/src/components/RunMonitor.tsx) + `useJobStatus` hook — live progress card, animated shimmer bar, log tail, error block
- **Pages**
  - [`Dashboard`](app/web/src/pages/Dashboard.tsx) — Active runs section (auto-refreshes while any are queued/running) + History section + demo case row
  - [`Intake`](app/web/src/pages/Intake.tsx) — anchor-nav sectioned flow: pedigree → HPO (with LLM-suggested dashed chips) → history (onset/prior testing) → file dropzones (per non-missing member) → run with prominent RunMonitor + auto-redirect
  - [`Workbench`](app/web/src/pages/Workbench.tsx) — inheritance-tab filter, collapsible filters bar (tier/gene/AF slider), variant table + detail drawer w/ all four panels; falls back to RunMonitor if the requested case isn't ready
  - [`Report`](app/web/src/pages/Report.tsx) — print-grade preview matching the PDF
- **In-browser VCF/BAM sniff** ([vcfSniff.ts](app/web/src/vcfSniff.ts)) — `DecompressionStream('gzip')` to read `##contig`+`#CHROM` of `.vcf.gz` without uploading, build detection from contig length, BAM magic-byte check, GIAB sample-name aliasing
- **case.json adapter** ([caseData.ts](app/web/src/caseData.ts)) — fetches `/demo/case.json` or `/api/cases/:id` and projects the engine's `CaseEmission` into UI `VariantRow`/`CaseRow`
- **Vite dev middleware** ([vite.devCaseApi.ts](app/web/vite.devCaseApi.ts)) — emulates Workers endpoints locally; persists job state to `data/uploads/<id>/status.json` so polls survive restarts

### Engine (Python)
- **Pure-Python VCF fallback** ([engine/joint.py](engine/src/variantgpt_engine/joint.py)) — uncompressed/biallelic; runs on Windows without cyvcf2/htslib
- **Inheritance modeling** ([engine/inheritance.py](engine/src/variantgpt_engine/inheritance.py)) — de novo (strict + assumed for duos), AR hom, comp het (gene-aware trans phasing), AD inherited, X-linked, Y-linked, mitochondrial; confidence grading drives PS2 vs PM6
- **Annotation** ([engine/annotation.py](engine/src/variantgpt_engine/annotation.py)) — has a `use_demo_annotations` fallback that consults [`tracks/demo_data.py`](tracks/demo_data.py) when VEP/tabix unavailable
- **ACMG point classifier** ([engine/acmg/](engine/src/variantgpt_engine/acmg/)) — Tavtigian transform; baseline criteria use gnomAD global only per spec §4.6 (so reclass is meaningful)
- **South Asian reclassification** ([engine/reclassify.py](engine/src/variantgpt_engine/reclassify.py)) — retracts PM2 if SAS sources show meaningful AF, fires BS1 against SAS thresholds, never auto-commits (PRD §4.10)

### Data
- **Curated demo dataset** ([tracks/demo_data.py](tracks/demo_data.py)) — 11 real ClinVar variants (HBB HbS/HbE, MEFV M694V, G6PD Ser188Phe, CFTR ΔF508+G542X, GJB2 35delG, BRCA1, ATM, TTN, AGRN) with real gnomAD v4.1 + IndiGenomes AFs
- **Trio VCF generator** ([tracks/build_demo_vcfs.py](tracks/build_demo_vcfs.py)) — emits proband/father/mother VCFs + PED with deliberate inheritance patterns
- **Demo case runner** ([tracks/build_demo_case.py](tracks/build_demo_case.py)) — engine on the demo trio → `app/web/public/demo/case.json`
- **Uploaded-case runner** ([tracks/run_uploaded_case.py](tracks/run_uploaded_case.py)) — invoked by the Vite middleware; gunzips `.gz` VCFs; rejects BAM with a spec-cited error; supports duos/singletons

## Verified live (last run)

| Path | Variants | Tiers | Reclass | Notes |
|---|---|---|---|---|
| Demo trio | 11 | 2 P · 2 LP · 4 VUS · 1 LB · 2 B | 1 (MEFV via IndiGenomes BS1) | ~600ms; updated 2026-05-25 after BS1 single-fire fix |
| Uploaded trio | 11 | identical | identical | ~600ms |
| **Duo** (mother+proband, father missing) | 11 | 1 P · 0 LP · 5 VUS · 3 LB · 2 B | 1 (MEFV) | ATM correctly weakens from LP→VUS (PS2 → PM6); 639ms — rerun after fixes pending |

## Stopped processes / freed ports

- Killed all `node` and `python` processes
- Port **5173** (Vite) — free
- Port **8787** (Workers dev, never actually started) — free

## What's NOT yet wired (the road ahead)

In the order they'd land next, per PRD §9:

1. **Workers API + D1/R2** — the [`app/api/`](app/api/) scaffold has Hono routes ([cases.ts](app/api/src/routes/cases.ts) etc.) but isn't deployed. The dev middleware exists so the UI contract is exercised; the same surface needs to land on Workers with D1 + R2 backing per [infra/migrations/0001_init.sql](infra/migrations/0001_init.sql).
2. **VEP / ANNOVAR / tabix tracks** — engine annotation currently uses `use_demo_annotations` for coord-matched fallback. Real cases need VEP (offline cache) + tabix-over-HTTP for IndiGenomes / GenomeAsia / dbNSFP (scripts scaffolded in `tracks/ingest_*.py`).
3. **Live gnomAD GraphQL** — adapter exists ([annotation_sources/gnomad.py](engine/src/variantgpt_engine/annotation_sources/gnomad.py)) but the query format is throwing 400s; needs a fix + integration with `use_gnomad` toggle.
4. **bcftools norm + CrossMap liftover** — adapters scaffolded in [normalize.py](engine/src/variantgpt_engine/normalize.py), [liftover.py](engine/src/variantgpt_engine/liftover.py) but only invoked when those binaries are on PATH. The dev box doesn't have them; engine works without via pure-Python read.
5. **More ACMG criteria** — these return `fired=False` until adapters exist: PS1, PM1, PM3, PM4, PM5, PP1, PP2, PP4, BS2, BS3, BS4, BP2, BP7
6. **LLM HPO extraction + narrative drafting** — Intake's "suggested" HPO is keyword-based mock; needs the AI Gateway → OpenRouter wiring (PRD §6.7). LLM never decides classifications (§4.8).
7. **Authentication** — none wired; PRD §5 requires it before any non-research deployment
8. **PDF report generation** — Report.tsx renders the preview; the `POST /cases/:id/report` endpoint should call a Python/Node PDF lib server-side
9. **Compound-het PM3 trans-partner ClinVar lookup** — the comp-het *detection* works, but PM3 doesn't auto-fire because it requires looking up whether the trans partner is P/LP in ClinVar
10. **GenomeIndia connector** — drop-in once an IBDC/FeED-approved AF extract is obtained

## Known limitations / gotchas

- **No git repo yet.** Initialize before further work: `git init && git add . && git commit -m "Initial scaffold + working demo"`
- **bcftools / tabix / cyvcf2 not installed.** The pure-Python VCF reader supports only uncompressed biallelic VCFs. Real WGS work requires htslib (install via conda or use Docker).
- **gnomAD live API returns 400** during demo runs. Auto-disabled when `use_demo_annotations=True` (current default for uploaded cases too); needs a fix on the adapter side before disabling demo fallback.
- **Python is 3.14** on this box; engine `pyproject.toml` declares `>=3.11`. Pydantic 2 works fine on 3.14 in practice.
- **No BAM support.** Engine errors out cleanly on BAM uploads (PRD §1 non-goal: read alignment). Intake-side dropzone accepts BAM only for forward compat / UX honesty.
- **Pedigree default is trio**; duo support is in but you have to click a parent and choose "No sample".
- **Multi-sample VCFs** — `vcfSniff.ts` extracts all sample names but the UI doesn't yet let you pick one; first sample is assumed.

## Resume command set

```bash
# Spin everything back up
cd D:\Projects\VariantGPT\app\web
npm run dev     # http://localhost:5173

# Regenerate the demo case from scratch
cd D:\Projects\VariantGPT
python tracks/build_demo_vcfs.py
python tracks/build_demo_case.py

# Hand-run an uploaded case (for engine debugging)
python tracks/run_uploaded_case.py <caseId>
```

## File map of new work (this session)

```
app/web/
  vite.config.ts                       (rewritten — uses devCaseApi plugin)
  vite.devCaseApi.ts                   (NEW — Workers API emulator)
  index.html                            (added font links)
  src/
    types.ts                            (extended: EvidenceRow, PopulationAF, Predictors, Criterion)
    types-pedigree.ts                   (NEW — PedigreeState + DEFAULT_TRIO; added .missing)
    caseData.ts                         (NEW — engine→UI adapter + useDemoCase hook)
    vcfSniff.ts                         (NEW — in-browser VCF/BAM header sniff)
    App.tsx                             (unchanged)
    pages/
      Dashboard.tsx                     (rewritten — active runs + history + demo)
      Intake.tsx                        (rewritten — pedigree+HPO+history+upload+RunMonitor)
      Workbench.tsx                     (rewritten — fetches case.json, RunMonitor fallback)
      Report.tsx                        (rewritten — print-grade preview)
    components/
      TierChip.tsx                      (unchanged)
      ReclassBadge.tsx                  (unchanged)
      EvidenceLedger.tsx                (NEW)
      PopulationFreqPanel.tsx           (NEW)
      PredictorGauges.tsx               (NEW)
      Pedigree.tsx                      (NEW)
      FileDropzone.tsx                  (NEW)
      RunMonitor.tsx                    (NEW)
    styles/
      tokens.css                        (unchanged — already aligned to spec)
      global.css                        (extended — ledger, popfreq, gauges, pedigree, dropzone, run-monitor, banners)

engine/src/variantgpt_engine/
  joint.py                              (added pure-Python VCF fallback)
  inheritance.py                        (de novo now grades trio→duo→none → PS2/PM6/none)
  annotation.py                         (added use_demo_annotations fallback via tracks/demo_data.py)
  pipeline.py                           (added use_demo_annotations param; auto-disables gnomAD when on)
  acmg/criteria.py                      (PM2/BA1/BS1 now use gnomAD-global only at baseline)
  reclassify.py                         (PM2-retracted only counted if PM2 actually fired baseline)

tracks/
  demo_data.py                          (NEW — 11 real curated variants)
  build_demo_vcfs.py                    (NEW — emits trio VCFs + PED with intentional inheritance)
  build_demo_case.py                    (NEW — runs engine → public/demo/case.json)
  run_uploaded_case.py                  (NEW — runs engine on uploaded data; supports duos)

data/test/demo_trio/
  proband.vcf, father.vcf, mother.vcf, family.ped, case.json   (generated)

app/web/public/demo/case.json           (generated — what the SPA fetches)
app/web/public/cases/<caseId>/case.json (generated per upload)
data/uploads/<caseId>/                  (uploaded VCFs + manifest.json + status.json)

HANDOVER.md                             (this file)
```

## Session 2026-05-25 — Cloudflare deploy port

Wired the production deploy path for the same SPA→engine slice. Architecture:

```
Pages (variantgpt-web)         ← React SPA build
   │
Worker (variantgpt-api)         ← Hono /api/*
   ├── D1 (variantgpt)          ← cases, members, jobs, uploads, evidence, …
   ├── R2 (variantgpt)          ← uploaded VCFs, case.json, reports
   └── Container (EngineContainer) ← Python engine, engine/Dockerfile
```

**Deploy doc:** [`infra/DEPLOY.md`](infra/DEPLOY.md) — full step-by-step.

### New files
- [`engine/Dockerfile`](engine/Dockerfile) — slim python:3.12 image; pure-Python engine stack (no htslib/cyvcf2)
- [`tracks/container_server.py`](tracks/container_server.py) — Starlette HTTP shim. `POST /run` downloads VCFs from signed R2 GET URLs, runs the engine, PUTs `case.json` to a signed R2 URL, posts HMAC-signed status callbacks back to the Worker.
- [`app/api/src/engineContainer.ts`](app/api/src/engineContainer.ts) — `Container` subclass; bound at `env.ENGINE`, accessed per-case via `idFromName(caseId)`.
- [`app/api/src/routes/api.ts`](app/api/src/routes/api.ts) — the `/api/*` surface that mirrors the Vite dev middleware contract.
  - `GET  /api/cases/:id/upload-url/:role?filename=…` → signed R2 PUT (sigv4 via `aws4fetch`)
  - `POST /api/cases/:id/run` → mints VCF GET URLs + case.json PUT URL, invokes container
  - `POST /api/internal/engine-callback/:id` → HMAC-verified status writes from the container
  - `GET  /api/cases/:id/status` · `GET /api/cases/:id` · `GET /api/cases`
- [`infra/migrations/0002_jobs_and_uploads.sql`](infra/migrations/0002_jobs_and_uploads.sql) — `jobs` + `uploads` tables.
- [`app/web/src/apiBase.ts`](app/web/src/apiBase.ts) — `api(path)` helper; reads `VITE_API_BASE` so the same SPA works in dev (relative `/api/*` → Vite middleware) and prod (absolute → Worker URL).
- [`app/web/wrangler.toml`](app/web/wrangler.toml) + [`public/_headers`](app/web/public/_headers) + [`public/_redirects`](app/web/public/_redirects) — Pages config.

### Changed files
- [`app/api/wrangler.toml`](app/api/wrangler.toml) — added `[[containers]]` + DO binding + R2/PUBLIC_API_BASE env
- [`app/api/src/bindings.ts`](app/api/src/bindings.ts) — added ENGINE DO, R2 sigv4 creds, PUBLIC_API_BASE
- [`app/api/src/index.ts`](app/api/src/index.ts) — re-exports `EngineContainer`; mounts `/api` router
- [`app/api/package.json`](app/api/package.json) — added `@cloudflare/containers`, `aws4fetch`
- [`app/web/src/pages/Intake.tsx`](app/web/src/pages/Intake.tsx) — upload swapped to two-step presigned-PUT flow (request URL, PUT bytes)
- [`app/web/vite.devCaseApi.ts`](app/web/vite.devCaseApi.ts) — added `/upload-url/:role` handler so dev mirrors the prod contract; PUT accepted alongside legacy POST

### Verified
- `cd app/api && npx tsc --noEmit` — passes
- `cd app/web && npx tsc --noEmit` — passes
- Smoke test on deployed Cloudflare account — **deferred** (requires user's Cloudflare creds; playbook in [DEPLOY.md](infra/DEPLOY.md))

### Decisions made
1. **Cloudflare Containers (beta) for engine runtime** — keeps everything on one platform. Trade-off: beta API stability. Image size ~200 MB (pure-Python stack only).
2. **Presigned R2 PUT URLs for uploads** — bypasses Workers body-size limits; required for real WGS. SPA contract is filename-via-query-string so dev and prod URL handlers are interchangeable.
3. **HMAC-signed callbacks** rather than mTLS / token auth — container only knows the shared secret; constant-time compare in the Worker.
4. **Per-case container instances** via `idFromName(caseId)` — gives isolation + lets `sleepAfter: 5m` reclaim idle instances without affecting concurrent cases.

## Session 2026-05-25 — code review fixes

Top-5 code-review pass before starting the Workers port. All landed:

1. **Upload path-traversal** ([vite.devCaseApi.ts](app/web/vite.devCaseApi.ts)) — `x-filename` extension is now whitelisted to `vcf` / `vcf.gz` / `bam`; resolved path is checked to stay inside the upload dir. Bad headers return 400.
2. **BS1 multi-fire** ([reclassify.py](engine/src/variantgpt_engine/reclassify.py)) — BS1 used to fire once per SAS source above threshold (doubling/tripling the benign points). Now fires at most once across all SAS sources, selecting the highest-AF source for determinism. **Behavior change:** the demo trio's MEFV M694V now lands at VUS-with-BS1 rather than LB — that's the correct math; the old LB was a double-count artifact.
3. **`reclass_points` math** ([reclassify.py](engine/src/variantgpt_engine/reclassify.py)) — used to sum only *changed* criteria, making `reclass_delta` meaningless. `reclassify()` now returns `(proposal, new_points)` where `new_points` is the full post-reclass ledger sum; `reclass_delta = new_points - baseline_points` is now correct and the UI `Δ±n` badge reflects reality.
4. **`inflight` map never cleared** ([caseData.ts](app/web/src/caseData.ts)) — rejected fetches used to permanently poison the caseId. Added `.finally(() => inflight.delete(url))` so retries get a fresh request.
5. **Upload size cap + Python PATH** ([vite.devCaseApi.ts](app/web/vite.devCaseApi.ts)) — `pipeRequest` now enforces a 50 GB cap (413 on overflow, partial file unlinked). Engine spawn honors `$env:VARIANTGPT_PYTHON` so operators can pin the interpreter on Windows where `python` may resolve to the Store stub.

Tests: `pytest engine/tests/test_reclassify.py` → 3 passed. Demo case rebuilds cleanly.

## Spec deviations / decisions logged

1. **Baseline ACMG uses gnomAD-global only** (criteria.py PM2/BA1/BS1) — chosen so the SAS reclassification step has something to do. Was previously iterating all populations. Spec §4.6 implies this split.
2. **PM2 retraction in reclass only fires if PM2 actually fired baseline** — prevents misleading "VUS→VUS, changed PM2" stubs.
3. **`use_demo_annotations=True` for uploaded cases** — pragmatic fallback so users uploading the demo trio see rich annotations. Coord lookup misses (real unknowns) just leave annotations empty. Will be a no-op once VEP/tabix are wired.
4. **De novo for duos is "assumed" (medium confidence)** — fires PM6 (Moderate +2) instead of PS2 (Strong +4) per PRD §7 mapping.
5. **Job state persisted to `data/uploads/<id>/status.json`** — survives dev-server restarts; in-memory is still source of truth during a live run.
6. **Demo case ID `demo-trio-001` is reserved** — caseData.ts routes that ID to `/demo/case.json` instead of `/api/cases/`.
