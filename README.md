# VariantGPT

South-Asian-aware clinical variant interpretation for trio, duo, and singleton germline cases. Runs ACMG/AMP classification with population-AF reclassification against Indian-cohort databases (IndiGenomes, GenomeAsia, GenomeIndia), HPO phenotype matching, AI-drafted variant synopses, and a print-ready clinical report — with a built-in three-layer validation suite.

See [VariantGPT_PRD_TRD.md](VariantGPT_PRD_TRD.md) for product/technical requirements and [VariantGPT_Frontend_Design_Spec.md](VariantGPT_Frontend_Design_Spec.md) for the frontend design system. For session-by-session state see [HANDOVER.md](HANDOVER.md). For benchmark numbers see [Benchmarks.md](Benchmarks.md).

## Architecture

```
Cloudflare Pages (variantgpt-web)            ← React SPA build (Vite + TS)
   │
Cloudflare Worker (variantgpt-api, Hono)     ← /api/* edge surface
   ├── D1   (variantgpt)                     ← cases, members, jobs, uploads
   ├── R2   (variantgpt)                     ← VCFs, case.json, reports, caches
   └── Fly.io machine (variantgpt-engine)    ← Python engine, ~/tracks/container_server.py
                                                (was Cloudflare Containers; pivoted
                                                to Fly for memory headroom)
```

## Layout

```
engine/            Python engine — VCF preprocess, joint merge, GATK-style trio QC,
                   inheritance modeling, VEP REST + myvariant.info annotation, ACMG
                   point engine, South-Asian reclassification, HPO matching.
                   Importable library + CLI.
app/
  web/             Cloudflare Pages SPA — Home, Intake, Workbench, Report
  api/             Cloudflare Workers edge API
tracks/            Engine orchestrator (container_server.py) + ingestion scripts
                   for population AF tracks
notebooks/         Colab notebooks for local engine experiments
infra/             D1 migrations, wrangler config
data/test/         Truth-set fixtures (demo trio)
.github/workflows/ CI for engine pytest + web build + Pages/Worker/Fly deploys
```

## Quick start

### Local dev (no Cloudflare required)
```
cd app/web
npm install
npm run dev          # → http://localhost:5173 (uses Vite dev API middleware)
```

### Engine (Python)
```
cd engine
python -m venv .venv && .venv\Scripts\activate
pip install -e .[dev]
variantgpt-engine --help
pytest
```

### Edge API (Workers)
```
cd app/api
npm install
npm run dev          # wrangler dev
```

### Deploy (CI)
Push to `main` — `.github/workflows/deploy.yml` deploys engine → api → web in order. See [`infra/DEPLOY.md`](infra/DEPLOY.md) for first-time setup (Cloudflare secrets, Fly tokens, R2 CORS, D1 migrations).

## Pipelines

The home screen offers three pipeline modes; all share the same engine and differ only in pedigree shape:

| Mode | VCFs | Notes |
|---|---|---|
| **Singleton** | proband only | De novo cannot be confirmed; comp-het / AR-hom still callable. |
| **Duo** | proband + 1 parent | De novo only at sites the present parent is 0/0. Trans-phasing partial. |
| **Trio** | proband + both parents | Full segregation. PS2 (de novo strong) and trans-phased comp-het both available. |

## Validation suite

Three layers — pick whichever matches the question:

| Layer | Where | Validates |
|---|---|---|
| **A. ClinVar audit** | Workbench panel (auto) | Per-case tier concordance vs ClinVar ≥2★ classifications |
| **B. Franklin diff** | `/cases/:id/diff` | Cross-platform agreement on the same trio (drop a Franklin CSV) |
| **C. GIAB benchmark** | [`python tracks/giab_benchmark.py`](tracks/giab_benchmark.py) | Reproducible per-tier P/R/F1, Cohen's κ on HG002/3/4 + ClinVar |

Activation guides: [`GIAB_benchmark.md`](GIAB_benchmark.md), [`GenomeAsia_config.md`](GenomeAsia_config.md). Results land in [`Benchmarks.md`](Benchmarks.md).

## AI synopsis

Per-variant clinical narrative drafted by Claude on demand. Click **Generate synopsis** in the workbench drawer; result is cached per `(caseId, variantId)` in localStorage so subsequent opens are free. Routes via Cloudflare AI Gateway when configured. The user prompt is structured (variant identity / fired ACMG / predictors / case context / HPO overlap) so the model can't hallucinate AFs or criteria.

## Non-diagnostic / research-use only

Every signed report carries the research-use disclaimer (PRD §4.9). Reclassification proposals never auto-commit — a human curator decision is recorded for every tier change (PRD §4.10).
