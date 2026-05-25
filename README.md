# VariantGPT

Trio/family germline variant interpretation platform with a South-Asian-aware ACMG reclassification engine.

See [VariantGPT_PRD_TRD.md](VariantGPT_PRD_TRD.md) for product/technical requirements and [VariantGPT_Frontend_Design_Spec.md](VariantGPT_Frontend_Design_Spec.md) for the frontend design system.

## Layout

```
engine/            Python 3.11+ engine — VCF intake, normalize, joint merge, QC,
                   inheritance modeling, annotation, ACMG point engine, South
                   Asian reclassification. CLI + importable library.
app/
  web/             Cloudflare Pages SPA (Vite + React + TypeScript)
  api/             Cloudflare Workers edge API (Hono, TypeScript)
tracks/            Ingestion scripts for IndiGenomes / GenomeAsia / GenomeIndia
notebooks/         Colab notebooks for running the engine end-to-end
infra/             D1 migrations, wrangler config, AI Gateway config
data/test/         Truth-set fixtures (GIAB trio refs, ClinVar benchmark)
.github/workflows/ CI for engine pytest + web build; deploy to Pages + Workers
```

## Status

Milestone 1 (engine core) and scaffold for milestones 7 (edge app) and 9 (frontend) are in place. See PRD §9 for the build order. Heavy genomics (VEP/ANNOVAR, bcftools, liftover) runs off-edge in the Python engine; the edge serves the compact annotated candidate set.

## Quick start

### Engine (Python)
```
cd engine
python -m venv .venv && .venv\Scripts\activate   # PowerShell on Windows
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

### Web (SPA)
```
cd app/web
npm install
npm run dev
```

## Non-diagnostic / research-use only
Every signed report carries the research-use disclaimer (PRD §4.9). Reclassification proposals never auto-commit — a human curator decision is recorded for every tier change (PRD §4.10).
