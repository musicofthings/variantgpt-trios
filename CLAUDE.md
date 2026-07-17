# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

VariantGPT is a South-Asian-aware clinical germline variant interpreter for trio / duo / singleton cases: ACMG/AMP classification with Indian-cohort allele-frequency reclassification, HPO phenotype matching, AI-drafted per-variant synopses, and a print-ready report. **Research-use only, non-diagnostic** — see "Invariants" below, they are load-bearing, not boilerplate.

Authoritative docs (read the relevant one before non-trivial work): `VariantGPT_PRD_TRD.md` (product/technical requirements — code comments cite it as "PRD §x"), `HANDOVER.md` (session-by-session state), `VariantGPT_Frontend_Design_Spec.md`, `Benchmarks.md` + `GIAB_benchmark.md` + `GenomeAsia_config.md` (validation), `security.md`, `infra/DEPLOY.md`.

## Three-tier architecture

The system is a monorepo of three independently deployed tiers. Data flows edge → off-edge and back via a signed webhook:

```
app/web    React SPA (Vite + TS)      → Cloudflare Pages   (variantgpt-web)
app/api    Hono Worker, /api/*        → Cloudflare Workers (variantgpt-api)
             ├─ D1 (variantgpt)  cases, members, jobs, uploads
             └─ R2 (variantgpt)  VCFs, case.json, reports, caches
engine/    Python genomics engine     → Fly.io machine     (variantgpt-engine)
             driven by tracks/container_server.py
```

**Why Fly, not Cloudflare Containers:** the engine needs memory headroom for VCF processing; the project pivoted off CF Containers. The Worker never runs genomics itself.

**Job lifecycle:** Worker `POST /cases/:id/run` sets case status `queued` in D1 (queue dispatch is still a TODO in `app/api/src/routes/cases.ts`). The engine on Fly receives a job at `container_server.py` `POST /run` with signed R2 GET URLs for the VCFs and a signed PUT URL for `cases/<id>/case.json`, runs the pipeline, streams status/log lines back to a callback URL, and writes `case.json`. Engine requests are bearer-authed (`ENGINE_BEARER`); webhook callbacks are HMAC-signed (`X-VGPT-Signature`, `ENGINE_WEBHOOK_SECRET`). `case.json` is the contract between engine and edge — its shape is the `CaseEmission` model in `engine/src/variantgpt_engine/models.py`.

## The engine pipeline (the core of the product)

`engine/src/variantgpt_engine/pipeline.py::run_case` wires every stage **in a fixed order** — changing the order breaks correctness, since later stages read earlier stages' annotations:

1. Optional read-calling front-end: FASTQ → BWA-MEM → BAM, or BAM/CRAM → GATK HaplotypeCaller → per-member VCFs (`bam_calling.py`). VCF inputs skip this.
2. `joint.merge` per-member VCFs → joint records; `qc.compute_qc` (GATK-style trio QC).
3. Per variant: `inheritance.assign_models` + `annotation.annotate` (VEP REST + myvariant.info + population AF tracks).
4. `inheritance.compound_het_pass` — needs gene assignment from step 3.
5. `acmg.classify` → **baseline** tier/points/evidence ledger; `prioritize.priority` folds in HPO overlap.
6. `acmg.augment_context_evidence` — context criteria (PM3/PP1) that need pedigree/segregation; re-tallies baseline.
7. `reclassify.reclassify_all` → South-Asian reclassification **proposals** (see Invariants).
8. `acmg.concordance.assess_all` — surfaces engine-vs-ClinVar disagreements for curator review (never overrides).
9. Structural/CNV variants from a pre-annotated AnnotSV TSV, if present.

External tools (GATK, bcftools, VEP, CrossMap, AnnotSV) are invoked only when on `PATH`; the pure-Python stages (merge, inheritance, ACMG, reclassification, CNV) always run on whatever upstream data exists — so the engine degrades gracefully in a minimal environment.

**ACMG scoring** uses the Tavtigian point transform (`acmg/points.py`: VS=8, S=4, M=2, P=1, negatives for benign, `BA=-1000` sentinel = hard-Benign override). Criterion evaluators live in `acmg/criteria.py`; the tier classifier in `acmg/engine.py`; thresholds in `acmg/thresholds.py`.

## Pedigree modes

Singleton / duo / trio share one engine and differ only in pedigree shape. What each can call: de novo (PS2) needs a full trio; duo only calls de novo where the present parent is 0/0; comp-het / AR-hom are callable in all modes. Don't special-case modes outside `pedigree.py` / `inheritance.py`.

## Commands

**Engine (Python, `engine/`)** — from the engine directory. Note the README shows Windows venv activation; on this macOS host use `.venv/bin/activate`:
```
python -m venv .venv && source .venv/bin/activate
pip install -e .[dev]
pytest                                    # all tests (testpaths=tests, src on pythonpath via pyproject)
pytest tests/test_reclassify.py           # one file
pytest tests/test_acmg_points.py::test_name   # one test
ruff check . && ruff format .             # line-length 100
mypy src
variantgpt-engine run --help              # CLI (Typer); entrypoint = variantgpt_engine.cli:app
```
`test_pipeline_e2e.py` runs the whole pipeline against `data/test/` fixtures — the fastest way to confirm an engine change end-to-end.

**Web SPA (`app/web/`):** `npm install`; `npm run dev` (→ http://localhost:5173, served with a Vite dev API middleware `vite.devCaseApi.ts` so no Cloudflare is needed locally); `npm run build` (`tsc -b && vite build`); `npm run typecheck`.

**Edge API (`app/api/`):** `npm install`; `npm run dev` (`wrangler dev`); `npm test` (vitest — see `*.test.ts` beside sources); `npm run typecheck`; `npm run deploy` (`wrangler deploy`).

**Deploy:** push to `main` → `.github/workflows/deploy.yml` deploys **engine → api → web in that order**. `ci.yml` runs engine pytest + web build. First-time secret/binding setup is in `infra/DEPLOY.md`.

**Population-AF tracks & benchmarks:** `tracks/` holds ingestion scripts (`ingest_genomeasia.py`, `ingest_genomeindia.py`, `ingest_indigenomes.py`) and `giab_benchmark.py` (reproducible per-tier P/R/F1 + Cohen's κ on HG002/3/4). `tracks/build_demo_*.py` regenerate the demo trio fixtures.

## Invariants (do not violate)

- **Reclassification never auto-commits.** `reclassify.py` emits `ReclassProposal` in `pending` status; every tier change requires a recorded human-curator decision (PRD §4.10). Do not add a code path that applies a proposal automatically.
- **South-Asian AF sources are exactly `indigenomes`, `genomeasia`, `genomeindia`.** gnomAD-SAS is deliberately excluded (Bangladeshi/diaspora-dominated, under-represents pan-Indian sub-populations). Don't add gnomAD-SAS to `SAS_SOURCES`.
- **Reclassification runs on LP/P too, not just VUS** — so a frequency-blind inflated call can be pulled *down* when an Indian source shows the allele is common. Preserve this bidirectionality.
- **ClinVar concordance is advisory** — it flags disagreements for review and must never override the engine's classification.
- **Every signed report carries the research-use / non-diagnostic disclaimer** (PRD §4.9). AI synopses are built from a structured prompt (variant identity / fired ACMG / predictors / case context / HPO) specifically so the model can't invent AFs or criteria — keep synopsis prompts structured, never free-form over raw data.
