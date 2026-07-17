# VariantGPT

South-Asian-aware clinical variant interpretation for trio, duo, and singleton germline cases. Runs ACMG/AMP classification with population-AF reclassification against Indian-cohort databases (IndiGenomes, GenomeAsia, GenomeIndia), HPO phenotype matching, AI-drafted variant synopses, and a print-ready clinical report — with a built-in three-layer validation suite.

See [VariantGPT_PRD_TRD.md](VariantGPT_PRD_TRD.md) for product/technical requirements and [VariantGPT_Frontend_Design_Spec.md](VariantGPT_Frontend_Design_Spec.md) for the frontend design system. For session-by-session state see [HANDOVER.md](HANDOVER.md). For benchmark numbers see [Benchmarks.md](Benchmarks.md).

## Architecture

```
Cloudflare Pages (variantgpt-web)            ← React SPA build (Vite + TS)
   │
Cloudflare Worker (variantgpt-api, Hono)     ← /api/* edge surface (the ONE
   │                                            case API; Clerk-authed, per-case
   │                                            owner-scoped — see Security below)
   ├── D1   (variantgpt)                     ← cases (owner_id), members, jobs, uploads
   ├── R2   (variantgpt)                     ← VCFs, case.json, reports, caches
   └── Fly.io machine (variantgpt-engine)    ← Python engine, tracks/container_server.py
                                                (was Cloudflare Containers; pivoted
                                                to Fly for memory headroom). Scales to
                                                zero: cold-starts on /run, stops itself
                                                when idle — see Engine lifecycle below.
```

### Security & tenancy

The `/api/*` Worker surface is the single canonical case API. Every request is
Clerk-JWT authenticated, and every case-scoped route is **owner-scoped**: a case
is stamped with its creator's user id (`cases.owner_id`, migration
`0004_case_owner.sql`) and a middleware 404s anyone else. When `CLERK_ISSUER` is
unset the Worker runs single-tenant dev mode (synthetic user). CORS reads an
`ALLOWED_ORIGINS` allowlist (never `*` in prod).

### Engine lifecycle & cost (scale-to-zero)

The Fly engine is a self-stopping worker, so you pay only for run-seconds:

- `fly.toml` sets `min_machines_running = 0` and `auto_stop_machines = "off"`.
- The Worker's `/run` cold-starts the machine (`auto_start`); Fly never idle-stops
  it mid-job (a case runs for minutes after the Worker connection drops).
- After the job posts its final callback, the engine stops **itself** via the Fly
  Machines API (`_self_stop_if_idle` in `tracks/container_server.py`), gated on no
  other in-flight job.

Requires a Fly API token so the machine can stop itself:

```
fly tokens create deploy -a variantgpt-engine
fly secrets set FLY_API_TOKEN=<token> -a variantgpt-engine
```

Without the token the engine simply never self-stops (safe fallback: stays up).
VM is `shared-cpu-2x / 4 GB` (the workload is network-bound; peak RAM ~2–3 GB).

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

First-time setup gotchas for the changes above:
- Apply D1 migrations before the Worker goes live — the API reads `cases.owner_id`: `wrangler d1 migrations apply variantgpt-db --remote`.
- Set `FLY_API_TOKEN` (see *Engine lifecycle* above) **before** the engine deploys, or the machine won't self-stop.
- Set `ALLOWED_ORIGINS` in `app/api/wrangler.toml` `[vars]` to the deployed SPA origin(s) for production.

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
