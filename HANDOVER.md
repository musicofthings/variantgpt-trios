# VariantGPT — Session Handover

**Last updated:** 2026-08-11
**Working tree:** `~/projects/variantgpt-trios` (git: `musicofthings/variantgpt-trios`, branch `main` — 2026-08-11 curator sign-off on reclassification, on top of `8f8a7e7` sibling-duo + production-crash fix)
**Specs:** [`VariantGPT_PRD_TRD.md`](VariantGPT_PRD_TRD.md) · [`VariantGPT_Frontend_Design_Spec.md`](VariantGPT_Frontend_Design_Spec.md)
**Deploy:** [`infra/DEPLOY.md`](infra/DEPLOY.md)

---

## TL;DR — what's live right now

A fully functional production deploy on Cloudflare + Fly with the entire SPA→Worker→Engine→case.json pipeline running end-to-end on real clinical WGS trio VCFs (~180k variants per sample → ~8.5k rare candidate variants surfaced).

```
Cloudflare Pages (variantgpt-web)                 ← React SPA (Vite + TS)
   │ /api/*  (the ONE case API — Clerk-authed + per-case owner-scoped)
Cloudflare Worker (variantgpt-api, Hono)          ← edge surface
   ├── D1   (cases[owner_id], members, jobs, uploads)
   ├── R2   (VCFs, case.json, cache stages)
   └── Fly.io machine (variantgpt-engine)         ← Python engine via HTTP
        shared-cpu-2x / 4 GB, SCALES TO ZERO        (tracks/container_server.py)
        (cold-starts on /run, self-stops when idle)
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
6. **myvariant.info batch** — ClinVar (significance / review_stars / conditions / variation_id) + **full dbNSFP predictor panel** (AlphaMissense / REVEL / CADD / SpliceAI / **SIFT / PolyPhen2 HVAR/HDIV / MutationTaster / LRT / FATHMM / PROVEAN / MetaSVM / MetaLR / VEST4** / phyloP / GERP) + gnomAD AF.
7. **IndiGenomes live API** — IGIB `data.php` queried per gene via Cloudflare Worker proxy (`/api/internal/indigen-proxy`) since Fly IPs are blocked by IGIB. MAX_GENES_PER_CASE=400, priority-sorted, 15s per-batch timeout, ANNOVAR↔VCF allele representation conversion for indel matching.
8. **mygene.info** — `fetch_gene_info_for_symbols` returns gene name + NCBI Entrez summary + type_of_gene + OMIM. Stored at case level (`CaseEmission.gene_info: dict[symbol → GeneInfo]`) so the report renders real gene-function prose per variant without duplicating across thousands of rows.
9. **HPO matching** ([annotation_sources/hpo_genes.py](engine/src/variantgpt_engine/annotation_sources/hpo_genes.py)) — downloads HPO consortium `genes_to_phenotype.txt` (~20 MB, 329k mappings), matches each variant's gene against case HPO terms; sets `v.hpo_matches` and boosts `priority_score`.
10. **ACMG classify** ([acmg/criteria.py](engine/src/variantgpt_engine/acmg/criteria.py)) — Tavtigian point system; per-variant criteria: PVS1, PS1, PS2, PM1, PM2, PM4, PM5, PM6, PP3, BA1, BS1, BS2, BP4, BP7. Context-aware criteria run as a post-classification pass ([acmg/context.py](engine/src/variantgpt_engine/acmg/context.py), `augment_context_evidence`, after phenotype scoring + comp-het + ClinVar, before reclassify): **PP4** (HPO phenotype-relevance ≥ 60 % Phrank, or 100 % coverage → Supporting), **PM3** (comp-het variant in trans with a ≥1★ pathogenic ClinVar partner in the same gene → Moderate), **PP1** (clean pedigree co-segregation: ≥2 affected carriers, no affected non-carrier, ≥1 informative unaffected non-carrier → Supporting; never fires on a single-affected trio). PS3 (functional studies) remains an honest not-fired stub — needs a functional-evidence dataset (MaveDB / ClinGen functional) not wired into the engine.
11. **South-Asian reclassification** ([reclassify.py](engine/src/variantgpt_engine/reclassify.py)) — `SAS_SOURCES = ("indigenomes", "genomeasia", "genomeindia")`. gnomAD-SAS deliberately excluded (not representative of Indian population). PM2 retracted / BS1 fired on highest-AF Indian source.

### Inheritance models

`InheritanceModel` ([models.py](engine/src/variantgpt_engine/models.py)) includes: `de_novo`, `ar_hom`, `comp_het`, `ad_inherited`, **`het_inherited`** (proband het transmitted from unaffected parent — most rare hets; was previously dumped to "unresolved"), `x_linked_recessive`, `x_linked_dominant`, `y_linked`, `mitochondrial`, `unresolved`.

### Caching / resume

R2 stage caches keyed by versioned URLs:
- `af_map` — myvariant.info AF lookup
- `csq_v2` — VEP REST annotation
- `variants_v7` — annotate + classify + HPO (current; bumped v6→v7 with expanded PredictorScores schema + case-level gene_info)

A failed/OOM run resumes from the last completed chunk; only the bumped stage rebuilds.

### Auth (fully enforced)

`@clerk/clerk-react` integrated in [`app/web/src/auth.tsx`](app/web/src/auth.tsx) + JWT validation in [`app/api/src/auth.ts`](app/api/src/auth.ts):
- `AuthGate` wraps `<App>`; when `VITE_CLERK_PUBLISHABLE_KEY` is set, signed-out users hit Clerk's hosted sign-in
- `TokenBridge` (inside `<SignedIn>`) plumbs Clerk's `getToken()` into the global `apiFetch()` token provider
- **Every** SPA call to `/api/*` uses `apiFetch()` which attaches `Authorization: Bearer <jwt>` automatically
- Worker `clerkAuthGated` middleware verifies JWT against Clerk JWKS (`jose` lib, JWKS cached per-isolate); validates `iss` + optional `aud`, extracts `sub` as user id
- `isPublicPath()` bypass for `/health`, `/`, and HMAC-signed internal webhooks (engine-callback, indigen-proxy)
- **Dev-mode fallback**: when `CLERK_ISSUER` Worker secret OR `VITE_CLERK_PUBLISHABLE_KEY` GHA variable is unset, the corresponding end becomes a pass-through. Production has both set

**Tenant isolation (2026-07-17).** Auth proves *who*; ownership proves *may they touch this case*. Every case is stamped with its creator's Clerk `sub` (`cases.owner_id`, migration [`0004_case_owner.sql`](infra/migrations/0004_case_owner.sql)); a `caseAccessGate` middleware on `/cases/:id[/*]` in [`routes/api.ts`](app/api/src/routes/api.ts) 404s non-owners (claim-on-first-touch for legacy NULL-owner rows). `GET /cases` and `/cases/cleanup` are owner-scoped; the orphan R2 scan is dev-mode-only (can't attribute orphans to a user). `/api/*` is the **single canonical case API** — the old `/cases`, `/variants`, `/proposals` routers are unmounted (unreachable, unsecured, querying unpopulated D1 tables; kept for the future curator UI). CORS reads an `ALLOWED_ORIGINS` allowlist, never `*`.

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

## Validation suite

Three layers live as of 2026-05-29:

| Layer | Where | What it answers |
|---|---|---|
| **A. ClinVar audit** | Workbench panel (auto-renders per case) | Per-case tier concordance against ClinVar ≥2★ classifications, with per-row "likely cause" hints |
| **B. Franklin (Genoox) diff** | `/cases/:caseId/diff` — drop Franklin CSV export | Cross-platform agreement, bucketed BOTH_AGREE / BOTH_DIFFER / FRANKLIN_ONLY / VARIANTGPT_ONLY |
| **C. GIAB benchmark** | `python tracks/giab_benchmark.py` | Reproducible per-tier precision/recall/F1 + Cohen's κ vs GIAB v4.2.1 truth + ClinVar reference |

Activation guides: [`GIAB_benchmark.md`](GIAB_benchmark.md) for layer C, [`GenomeAsia_config.md`](GenomeAsia_config.md) for the GenomeAsia track. Benchmark numbers go in [`Benchmarks.md`](Benchmarks.md) (template ready, real numbers TBD).

## AI synopsis

Per-variant clinical narrative drafted by Anthropic Claude on demand:
- Worker route `POST /api/ai/synopsis` ([`app/api/src/routes/ai.ts`](app/api/src/routes/ai.ts)) takes a `VariantPayload + CaseContext`, returns 2–3 paragraphs prefixed `AI-DRAFTED · REVIEW BEFORE SIGNING ·`
- Routes via Cloudflare AI Gateway when `AI_GATEWAY_ACCOUNT + AI_GATEWAY_ID` set; otherwise direct to `api.anthropic.com`
- SPA `<AiSynopsis>` in Workbench drawer: manual **Generate** button, result cached in localStorage per (caseId, variantId)
- System prompt blocks the model from issuing classification decisions; user prompt structured into Variant/Fired ACMG/Predictors/Case-context blocks so it can't hallucinate AFs

## Known gaps / road ahead

1. **GenomeAsia 100K data ingestion** — task #35 scaffold complete (engine adapter + ingestion CLI + Worker URL signing all wired). Activates the moment `tracks/ingest_genomeasia.py` runs with downloaded VCFs and `GENOMEASIA_R2_PREFIX` is set on the Worker. Data path itself blocked from cloud egress; user runs ingestion from residential/VPN'd network. **Blocked — no GenomeAsia data access yet** (confirmed 2026-06-02; stays on the roadmap). See [`GenomeAsia_config.md`](GenomeAsia_config.md).
2. ~~**Worker-side rate limiting on `/api/*`**~~ — ✅ done (2026-06-02, [ratelimit.ts](app/api/src/ratelimit.ts)). Per-user (Clerk sub, IP fallback) via Cloudflare's native Rate Limiting binding; 600 req/60s; internal+health exempt; dev pass-through when binding absent.
3. ~~**LLM HPO extraction**~~ — ✅ done (2026-06-02, [ai.ts](app/api/src/routes/ai.ts) `POST /api/ai/hpo-extract`). Two-stage: Claude extracts phenotype phrases → OLS4 grounds each to a real HP: id. SPA Intake "Suggest HPO terms from history" button. **AI synopsis drafting** already shipped 2026-05-29. PRD §6.7 closed.
4. ~~**Server-side PDF generation**~~ — ✅ done (2026-06-02, [report.ts](app/api/src/report.ts), `GET|POST /api/cases/:id/report`). Self-contained server-rendered HTML (archival, no JS/auth to render); `?format=pdf` uses Cloudflare Browser Rendering REST when `BROWSER_RENDERING_TOKEN` is set, else 501→HTML. SPA Report "Archival HTML" button.
5. ~~**Compound-het PM3 trans-partner ClinVar lookup**~~ — ✅ done (2026-05-29). ~~PS1 / PM5 (ClinVar-by-gene+codon index)~~ — ✅ done (2026-06-02, [clinvar_aa.py](engine/src/variantgpt_engine/annotation_sources/clinvar_aa.py) + [acmg/context.py](engine/src/variantgpt_engine/acmg/context.py)). Remaining ACMG gaps: **PS3** (needs a functional-evidence dataset — MaveDB / ClinGen functional), **PP2** (needs gene missense-constraint + mechanism data), **BS3 / BS4 / BP2**.
6. **Unpinned dependency floors** (`engine/pyproject.toml` dev deps, `engine/Dockerfile` runtime deps) — `ruff` and `starlette` are now pinned exactly after each broke `main`/production respectively on 2026-08-10 with zero source changes (a version bump alone). `pydantic`, `httpx`, `requests`, `networkx`, `uvicorn` are all still `>=` floors and carry the same latent risk of a future rebuild silently breaking on an upstream release. Worth auditing/pinning proactively rather than waiting for the next one to hit production.
7. **CNV/SV** — shipped 2026-06 (ClinGen/ACMG 2019 dosage classifier in
   `acmg/cnv.py`, AnnotSV ingestion, gCNV/Manta calling). Mitochondrial
   heteroplasmy remains out of scope per PRD §1. Deploy-side, CNV *calling*
   still needs a gCNV PON bundle uploaded to R2.
8. ~~**Curator sign-off on reclassification**~~ — ✅ done (2026-08-11). See the
   session log below. Remaining nearby work: pending-proposal surfacing in the
   Analysis Workbench, and report *signing* (`cases.signed_by`/`signed_at` are
   still unused columns).

### Resolved this session (2026-05-28)
- ✅ CI lint debt cleared (`ruff check src tests` clean)
- ✅ Worker-side Clerk JWT validation (jose-based JWKS verify, isolate-cached)
- ✅ Singleton/duo `<PipelineModeBanner>` listing explicit ACMG limitations per mode
- ✅ Path-filter CI live (dorny/paths-filter; engine/api/web jobs skip when slice untouched)

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

### Required env vars

**GitHub Actions Variables** (Settings → Secrets and variables → Actions → Variables) — bundled into the SPA at build time by Vite:
- `VITE_CLERK_PUBLISHABLE_KEY` — `pk_test_…` / `pk_live_…`. Leave unset for dev-mode SPA pass-through.

(Note: Cloudflare Pages dashboard env vars do NOT reach our GHA build — those only apply to Pages-managed builds. We use `wrangler pages deploy` with a pre-built artifact, so the value must come from GHA Variables.)

The `VITE_API_BASE` is hardcoded in the workflow file itself.

### Required Worker secrets (`wrangler secret put …`)

`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `ENGINE_BEARER`, `ENGINE_WEBHOOK_SECRET`, `INDIGEN_PROXY_BEARER`, `CLERK_ISSUER` (e.g. `https://apt-ant-91.clerk.accounts.dev`), optional `CLERK_AUDIENCE`, plus existing AI Gateway / OpenRouter keys. Set `ALLOWED_ORIGINS` (CORS allowlist, comma-separated) in `app/api/wrangler.toml` `[vars]` for production.

### Required Fly secrets (`fly secrets set … -a variantgpt-engine`)

`ENGINE_BEARER` (matches the Worker's), and **`FLY_API_TOKEN`** — the Machines API token the engine uses to stop itself for scale-to-zero (`fly tokens create deploy -a variantgpt-engine`). Without it the machine never self-stops (safe fallback: stays running). D1 migrations must be applied before the Worker goes live (`wrangler d1 migrations apply variantgpt-db --remote`) since the API reads `cases.owner_id`.

---

## Session log

### 2026-08-11 (latest) — Curator sign-off on reclassification (PRD §4.10 closed)

The §4.10 invariant ("reclassification never auto-commits; every tier change
requires a recorded human-curator decision") was enforced in the *engine* —
`reclassify.py` emits every proposal `pending` — but nowhere else. There was no
way to record a decision and nothing consumed one:

- The Workbench drawer had **Accept / Reject / Modify… buttons with no
  `onClick`** and the caption "Decisions are audit-logged and irreversible".
- `routes/proposals.ts` held a decision endpoint that was **unmounted**,
  unauthorized, and queried D1 tables (`reclass_proposals`, `variants`) that the
  pipeline never populates — the real data lives in R2 `case.json`.
- **The report asserted classifications nobody approved.** `report.ts::tierOf`
  returned `reclass_tier ?? baseline_tier`, so a signed report printed the
  proposed tier for a proposal still sitting at `pending`. `Report.tsx` narrated
  it as fact ("South-Asian allele-frequency review *reclassified* this variant
  from X to Y") under a section headed "Reclassification decisions" whose
  Decision column was the hardcoded string `Pending`.

Now closed end-to-end:

- **Schema** — [`0005_reclass_decisions.sql`](infra/migrations/0005_reclass_decisions.sql).
  Keyed `(case_id, variant_id)` against the case.json emission, not the empty D1
  variants table. **Append-only**: re-deciding inserts a new row and the previous
  one stays; the live decision is `ORDER BY decided_at DESC, rowid DESC` (rowid
  breaks same-second ties — `datetime('now')` is second-resolution).
- **Fingerprinting (the correctness core).** Each decision stores a
  `proposal_fingerprint` = tier movement + the changed-criteria set,
  order-independent. If the engine re-runs and the proposal changes, the
  fingerprint no longer matches, the decision is reported **stale**, and the
  variant returns to pending. Without this a rerun would silently inherit
  approval for evidence nobody looked at.
- **Rules module** — [`app/api/src/decisions.ts`](app/api/src/decisions.ts),
  pure and unit-tested. `resolveTier()` is the single answer to "what tier does
  this variant carry?": **pending, stale, and rejected all report the BASELINE
  tier.** `report.ts` and the SPA both call it, so screen and paper can't
  disagree. Rejections and modifications require a rationale note (disagreeing
  with the engine without saying why makes the audit trail useless); accepts
  don't.
- **API** — `GET|POST /api/cases/:id/decisions` in
  [`routes/api.ts`](app/api/src/routes/api.ts), owner-scoped for free via the
  existing `caseAccessGate`. Writes `reclass_decisions` + `audit_log` in one
  batch. `variant_id` travels in the POST body, not the path — engine ids are
  `chrom:pos:ref:alt` and don't survive a path segment.
- **Report** — the server renderer takes live decisions and gained a cover-page
  ledger (proposal / decision / reported-as / curator / date / rationale) with a
  loud banner when proposals are undecided. Its disclaimer now carries the
  **research-use / non-diagnostic** wording the §4.9 invariant requires (it
  previously said only "provisional… confirm before patient care").
- **SPA** — real `<ReclassDecision>` panel replacing the dead buttons, always
  stating *"Reported classification: X"* so a pending proposal can never read as
  a classification; per-row decision chips; a `N pending` badge on the
  Reclassified tab; report prose rewritten to say "**proposed** reclassifying …"
  plus the decision outcome.
- **Dev parity** — `vite.devCaseApi.ts` implements the same endpoints against a
  `decisions.json` file, importing the rules from `src/decisionRules.ts` (kept
  free of `import.meta.env` so it loads in the Vite config's Node context).
- `routes/proposals.ts` **deleted** — superseded.
- Tests: 23 new in `decisions.test.ts` + 6 in `report.test.ts`; API suite 50
  passed, both typechecks + web build clean. Verified in the browser against
  `duo-test` (MEFV VUS→LB): reject-with-note → accept → append-only history of 2
  rows, and a tampered fingerprint correctly flipped the variant back to
  "Needs re-review".

⚠️ **Deploy prerequisite:** apply migration `0005` (`wrangler d1 migrations
apply variantgpt-db --remote`) **before** the next Worker deploy — the report
route reads `reclass_decisions` and will 500 without the table.

Still open here: `AnalysisWorkbench` doesn't surface pending proposals, and
nothing blocks generating a report while proposals are undecided (it warns
loudly instead). Signing (`cases.signed_by` / `signed_at`) is still unused.

### 2026-08-10 — Sibling-duo pedigree, CI dependency drift, production crash fix, Fly cost audit

Four PRs merged to `main`: `9e750bb`/`4525a89` (PR #1, sibling-duo pedigree),
`36cdd1f` (PR #3, pedigree-builder swap-back bug), `689539e` (PR #4, production
crash — the important one). Plus a same-day Fly.io cost investigation that
turned up the crash but concluded with no further infra changes.

- **Sibling-based duo pedigree** (proband + one sibling, no parent sequenced).
  Previously silently mishandled: `pedigree.py`'s `_infer_role` derived role
  from substring-matching the id string, so a sibling with no parent recorded
  always round-tripped as `Role.relative`. PED loader now accepts explicit
  `role`/`sib_of` trailing columns (written by `_build_ped` from the pedigree
  JSON directly, backward-compatible with plain 6-column PED files);
  `inheritance.py` gained a `_siblings_of` helper + two sibling-aware signals
  in `assign_models` (affected-sibling shared-het → `het_inherited` instead of
  `unresolved`; unaffected-sibling AR-hom match → confidence downgrade, not a
  new ACMG criterion — PP1 already credits this role-agnostically once `Role`
  round-trips). Frontend: `DEFAULT_SIBLING_DUO` preset + a duo-shape swap
  button in [`Pedigree.tsx`](app/web/src/components/Pedigree.tsx); fixed
  `inferPipelineMode`, which had classified a sibling-only pedigree as a plain
  singleton. Follow-up PR #3 fixed a real bug found via live testing: swapping
  parent→sibling left the generic "+ Add father/mother" buttons visible,
  which added a parent as an unintended *third* member instead of swapping
  the sibling back out — now `isSiblingDuo` hides those and offers explicit
  father/mother swap-backs instead. New tests: `engine/tests/test_inheritance.py`
  (didn't exist before — `assign_models` was previously only exercised via the
  trio e2e fixture) + sibling-duo PED loader cases.
- **CI dependency drift (twice in one day — a pattern worth remembering).**
  `main`'s `ruff check` broke with 308 findings and zero source changes:
  `engine/pyproject.toml` had `ruff>=0.4` unpinned, and ruff 0.16.0's default
  rule selection is dramatically broader than 0.15.22's (verified empirically
  — a bare `pyproject.toml` with no `[tool.ruff]` triggers `UP045` etc. under
  0.16.0 but not 0.15.22). Pinned `ruff==0.15.22` + added an explicit
  `[tool.ruff.lint] select` so a future ruff release can't silently repeat
  this. **Same class of bug hit production hours later**: `engine/Dockerfile`
  had `starlette>=0.37` unpinned; a rebuild picked up starlette 1.6.0, which
  removed the `Starlette(on_startup=[...])` constructor kwarg entirely (ASGI
  `lifespan=` context manager required instead). The Fly machine was
  crash-looping on every boot (`exit_code=1` within ~5-8s, confirmed via
  `fly logs`, Fly's runner had hit "max restart count of 10" and given up) —
  **any real case submitted via the Worker during that window would have
  failed**. Fixed in [`container_server.py`](tracks/container_server.py) (new
  `_lifespan` async context manager wrapping the existing `_on_startup()`) +
  pinned `starlette==1.6.0` in the Dockerfile. Both fixes verified locally
  before pushing (reproduced the exact crash in a matching venv, drove the
  ASGI lifespan protocol + a `GET /healthz` directly) since this sandbox has
  no network path to fly.io to test against a real deploy. **Lesson: the
  unpinned-floor pattern (`package>=X`) in both `engine/pyproject.toml` dev
  deps and `engine/Dockerfile`'s runtime deps is a real, recurring risk — only
  `starlette` and `ruff` are pinned exactly now; the rest (`pydantic`,
  `httpx`, `requests`, `networkx`, `uvicorn`) still carry the same latent
  exposure.**
- **Fly.io cost audit (~$31/mo billed in July, "machines were off").** Cost
  Explorer breakdown: ~69% (`$21.54`) was compute for a stale `shared-cpu-4x`
  machine that hadn't been redeployed since it was created 2026-06-11 (the PR
  #1 merge's engine-path deploy on 07-27 finally redeployed it down to the
  correct `shared-cpu-2x/4GB` from `fly.toml` — zero compute billed since).
  Confirmed `FLY_API_TOKEN` is set (self-stop is genuinely armed) and the
  volume is 50GB against a documented `--size 10` intent — actual usage is
  only 16GB (`refs/` reference genome + BWA index = 8.3GB, AnnotSV install +
  deps = the rest). **Decided not to shrink the volume**: Fly volumes can't
  resize down in place, snapshot-restore and `volumes fork` both require the
  target ≥ the source's *nominal* size (not actual data used) so neither
  helps, and a Fly Machine can only ever mount one volume — freeing the old
  volume to copy off it would require destroying the live production machine
  first, a real (if brief) availability risk for ~$4-5/mo of savings. Left at
  50GB; ongoing cost floor is ~$9.65/mo (volume + its scheduled snapshots).

### 2026-07-17 — Security review, tenant isolation, Fly scale-to-zero, CI green

Code-review pass on the deployed stack, then fixes shipped in severity order and
verified live. Three commits to `main`: `ab97e88` (security), `9dda97a` (Fly
cost), `cd706bb` (lint), `7cd0c91` (CI actions). D1 migration `0004` applied to
remote; engine redeployed to Fly; CI + deploy both green.

- **Tenant isolation (high).** Auth was enforced but authorization wasn't — any
  signed-in user could read/modify any case by id (IDOR on patient genomic data).
  Added `cases.owner_id` (migration [`0004_case_owner.sql`](infra/migrations/0004_case_owner.sql), applied `--remote`) + a `caseAccessGate` on `/cases/:id[/*]` in [`routes/api.ts`](app/api/src/routes/api.ts) that 404s non-owners and claims legacy NULL-owner rows on first touch. `GET /cases`/`cleanup` owner-scoped; orphan scan dev-only. See *Auth* above.
- **Case-API consolidation (high/med).** The old `/cases`, `/variants`, `/proposals` routers were an unreachable, unsecured second surface (SPA only ever calls `/api/*`) whose `/run` set status `queued` but never dispatched. Unmounted them in [`index.ts`](app/api/src/index.ts); stub `/run`/`/report` now 501. `/api/*` (owner-scoped) is canonical.
- **Other review fixes.** CORS `*` → `ALLOWED_ORIGINS` allowlist; variants list filter pushed into SQL (was filtering *after* `LIMIT 500`, silently dropping matches); engine bearer compare → `hmac.compare_digest` (constant-time); BA1 reclass evidence item carries `points_for("BA")` so `reclass_points`/`delta` reflect the benign override.
- **Fly scale-to-zero (cost).** Idle `shared-cpu-4x/8 GB` at `min_machines_running=1` was billing ~$57/mo. Now a **self-stopping worker**: [`container_server.py`](tracks/container_server.py) tracks in-flight jobs and stops the machine via the Fly Machines API once idle (`_self_stop_if_idle`, gated on no other job + startup grace); [`fly.toml`](fly.toml) set to `min=0` / `auto_stop="off"` / `auto_start=true` and downsized to `shared-cpu-2x/4 GB`. Requires `FLY_API_TOKEN` secret (set on the app). Pay only for run-seconds. Added root [`.dockerignore`](.dockerignore) (build context 398 MB → a few MB).
- **CI green.** Cleared 44 pre-existing `ruff` violations blocking the engine job's pytest (dead vars in `sv_pipeline.py`, unused import in `test_cnv.py`, 40 semicolons in `test_bam_calling.py`), and bumped GitHub Actions to Node-24 majors (`checkout@v5`, `setup-node@v5`, `setup-python@v6`). All three CI jobs pass; deploy pipeline green.

### 2026-06-02 — Roadmap sweep: PS1/PM5, rate limiting, LLM HPO, server-side report

Four road-ahead items closed (GenomeAsia stays blocked — no data access yet).
Merged to `main` (`bf121b0`), plus a follow-up Server-PDF button + Report
hooks-order fix (`a27b58c`).

- **ACMG PS1 + PM5 via ClinVar amino-acid index** ([clinvar_aa.py](engine/src/variantgpt_engine/annotation_sources/clinvar_aa.py)). New source enumerates P/LP missense from ClinVar (myvariant.info query API) per case gene, indexed by (gene, codon, alt_aa). Context pass ([acmg/context.py](engine/src/variantgpt_engine/acmg/context.py)) fires **PS1** (Strong — same aa change, different nt; self-match guarded by genomic id) and **PM5** (Moderate — novel missense at a residue where a *different* P/LP missense is established; stands down when PS1 fires). Thin/defensive network layer degrades to empty index (not-fired) on failure. Wired into [container_server.py](tracks/container_server.py) (priority-sorted gene set, MAX_GENES=400) before the existing context pass; demo/pipeline keep the offline no-index default. 20 new tests; full engine suite 56 passed, ruff clean.
- **Per-user rate limiting** ([ratelimit.ts](app/api/src/ratelimit.ts)) on `/api/*` via Cloudflare's native Rate Limiting binding (`[[unsafe.bindings]]` ratelimit, 600/60s). Buckets by Clerk sub (IP fallback); internal+health exempt; dev pass-through when binding absent; 429 + Retry-After. 7 vitest cases.
- **LLM HPO extraction** ([ai.ts](app/api/src/routes/ai.ts) `POST /api/ai/hpo-extract`). Two-stage so the model can never mint an HP id: Claude returns phenotype phrases (drops negated/normal/family/meds/demographics) → OLS4 (`olsSelect`, factored into new [hpo.ts](app/api/src/hpo.ts), shared with the `/hpo/search` typeahead) grounds each to a real HP: term. SPA Intake "Suggest HPO terms from history" button; suggested chips carry the source phrase; offline regex baseline retained + merged; 503 graceful fallback. Tolerant phrase parser, 7 vitest cases.
- **Server-side clinical report** ([report.ts](app/api/src/report.ts), `GET|POST /api/cases/:id/report`). Pure `buildReportHtml(emission, selectedIds?)` builds a self-contained, print-ready HTML doc from case.json (cover + patient details + HPO + selected-findings, then per-variant pages with fired-only ACMG, family calls, AFs, predictors, reclassification). `?format=pdf` → Cloudflare Browser Rendering REST when `BROWSER_RENDERING_TOKEN` set, else 501→HTML. SPA Report toolbar gets **"Archival HTML"** + **"Server PDF"** buttons (JWT fetch → blob download; Server PDF shows a busy state + friendly 501 message). 8 vitest cases; verified in preview against the real demo case.json (cover + 11 variant pages, BRCA1 PVS1/PM2/PP3/PP4). API suite 22 passed; tsc + web build clean. (Follow-up `a27b58c` also fixed a latent Report Rules-of-Hooks bug — a `useMemo` below the loading/error early-returns crashed the page on cold load.)

### 2026-05-29 — Context-aware ACMG criteria: PP4 + PM3 + PP1

Three previously-stubbed ACMG criteria now fire, via a post-classification pass
([acmg/context.py](engine/src/variantgpt_engine/acmg/context.py)) that runs once
the rest of the annotation context exists (phenotype scores, comp-het config,
ClinVar) and re-tallies each variant's baseline points + tier before reclassify.

- **PP4** — consumes the phenotype-relevance score from the HPO work above.
  Fires Supporting when Phrank ≥ 60 % (or coverage = 100 %); supporting-only,
  never escalates. Demo: fires on BRCA1 / HBB / HBB (≥60 %); ATM (54) / MEFV (45)
  / G6PD (40) stay below. One HBB moves LB→VUS (phenotype-relevant variants
  shouldn't sit at Likely Benign).
- **PM3** — for a comp-het variant, fires Moderate when a *different* variant in
  the same gene (the in-trans allele established by `compound_het_pass`) carries
  a ≥1★ pathogenic ClinVar classification. Closes the road-ahead PM3 gap.
- **PP1** — clean pedigree co-segregation (≥2 affected carriers, no affected
  non-carrier, ≥1 informative unaffected non-carrier). Conservative: doesn't
  penalize unaffected carriers (AR), and a single-affected trio never reaches the
  ≥2 bar — correct, a trio has no segregation power on its own.
- **PS3 not implemented** — needs a functional-evidence dataset (MaveDB / ClinGen
  functional assertions) that isn't wired in; left as an honest not-fired stub
  rather than a fabricated call.
- Wired into [container_server.py](tracks/container_server.py) (after HPO
  scoring, before reclassify), [pipeline.py](engine/src/variantgpt_engine/pipeline.py),
  and [build_demo_case.py](tracks/build_demo_case.py). `augment_context_evidence`
  is idempotent + re-tallies. **No frontend change needed** — the generic
  EvidenceItem renderer + POLARITY/STRENGTH maps already cover PP4/PM3/PP1.
- Tests: [tests/test_acmg_context.py](engine/tests/test_acmg_context.py) — 12 tests
  (PP4 thresholds/coverage/absent; PM3 trans-partner/star-gating; PP1 trio-null /
  cosegregation / affected-non-carrier veto; BA1-override re-tally). Full suite
  green (36 passed).

### 2026-05-29 (later) — HPO phenotype-proximity ranking + Analysis Workbench

Graded phenotype relevance, replacing the old boolean gene↔HPO match.

- **Engine — ontology + IC** ([annotation_sources/hpo_ontology.py](engine/src/variantgpt_engine/annotation_sources/hpo_ontology.py)): lazy-loads `hp.obo` (~10 MB, cached `/tmp/variantgpt/hp.obo`), builds the is_a DAG + memoized ancestor closure, and derives per-term Information Content from `genes_to_phenotype` annotation propagation. Exposes Resnik-MICA, best-match-average, and Phrank scorers. Degrades to 0.0 (never raises) when the obo can't load.
- **Engine — scorer** ([phenotype.py](engine/src/variantgpt_engine/phenotype.py)): `PhenotypeScorer(case_hpo_ids)` precomputes per-algorithm perfect-match denominators, then `.score(gene)` returns a `PhenotypeRelevance` = `{coverage, resnik, phrank}`, each a normalized 0–100 % + per-term contribution breakdown (contributions sum to percent/100). **All three algorithms precomputed and baked into case.json** so the UI switches algorithm as a pure display toggle.
- **Engine — models** ([models.py](engine/src/variantgpt_engine/models.py)): `PhenotypeRelevance` / `PhenotypeScore` / `PhenotypeTermContribution`; `Variant.phenotype_relevance`. `hpo_matches` retained (= exact-coverage hits) for back-compat.
- **Engine — pipeline** ([container_server.py](tracks/container_server.py)): boolean HPO block replaced with full 3-algorithm scoring; `priority_score` boost now `+0.5 × phrank%` (coverage% when ontology unavailable). Cache key **`variants_v7 → v8`** ([api.ts](app/api/src/routes/api.ts)).
- **Demo** ([build_demo_case.py](tracks/build_demo_case.py)): now phenotype-scores the demo on rebuild. Real result: G6PD scores 0 % coverage but **59 % Resnik / 40 % Phrank** (G6PD deficiency → hemolytic anemia is ontologically close to HP:0001903 even without an exact term), while unrelated GJB2/AGRN sit ~1 %. The graded-proximity payoff, visible in the demo.
- **Frontend** — sortable **Phenotype %** column on the Workbench (default Phrank, shown when the case has HPO terms); new **Analysis Workbench** (`/cases/:caseId/analysis`, [pages/AnalysisWorkbench.tsx](app/web/src/pages/AnalysisWorkbench.tsx)) — the intermediate curation screen between triage and report: algorithm selector (coverage/resnik/phrank) that re-sorts live, per-variant HPO-term contribution breakdown, final report-selection checkboxes. Workbench's primary CTA becomes **Curate in Analysis →** (phenotype cases). Shortlist hand-off persisted per-case in localStorage ([selection.ts](app/web/src/selection.ts): `SELECTION_KEY` → `FINAL_KEY`). Shared scoring helpers + relevance bar in [phenotype.tsx](app/web/src/phenotype.tsx).
- **Tests**: [tests/test_phenotype.py](engine/tests/test_phenotype.py) — 8 tests on a synthetic DAG (exact/sibling/partial/root-only/unannotated, contribution-sum invariant, ontology-absent fallback). Full engine suite green (24 passed); web typecheck + build clean; verified in browser preview.
- This realizes the [prioritize.py](engine/src/variantgpt_engine/prioritize.py) §4.7 "Resnik/Phrank/Lin" stub that was previously unwired.

### 2026-05-29 — Validation suite + GenomeAsia scaffold + AI synopsis

- **Validation A**: `<ClinvarAudit>` panel on Workbench. Auto-renders for any case with ≥2★ ClinVar-classified variants. Buckets: CONCORDANT, RECLASS_AGREE, WEAK_DISCORD, MISSED_PATH, OVERCALLED. Concordance rate colored green ≥85% / rust below. Per-row likely-cause hints (no fired pathogenic criteria → missing ACMG criterion; etc.). Click any row → drawer opens for evidence inspection.
- **Validation B**: `/cases/:caseId/diff` route + `<FranklinDiff>` component. CSV parser handles Franklin's full schema with header aliasing. Joins by (chr, pos, ref, alt). Bucketed BOTH_AGREE / BOTH_DIFFER / FRANKLIN_ONLY / VARIANTGPT_ONLY. Per-row notes hypothesise divergence cause (`Franklin keeps this; we filtered as common (AF > 1%)`, etc.). Includes a calibration banner noting Franklin uses GenomeAsia internally — explains why some Franklin-only variants close once our GenomeAsia track activates.
- **Validation C**: `tracks/giab_benchmark.py` CLI. Detection sensitivity vs GIAB v4.2.1 (recall on SNVs and indels, BED-clipped to high-confidence regions). Classification concordance vs ClinVar ≥2★ (confusion matrix, per-tier P/R/F1, Cohen's κ with prose interpretation, discordant-variant punch list with cause hints). Outputs `benchmark.json` + `benchmark.md`. `GIAB_benchmark.md` walks through how to run it.
- **GenomeAsia 100K scaffold**: engine adapter + ingestion CLI + Worker URL signing all wired. `tracks/ingest_genomeasia.py` reads composite VCFs and writes chrom-partitioned AF TSVs to R2; `annotation_sources/genomeasia.py` reads them back. `maybeGenomeAsiaTemplate()` in the Worker mints one signed URL per chrom (sigv4 requires per-path signing) and encodes the map as `json:<base64>`. Engine activates the moment `GENOMEASIA_R2_PREFIX` Worker secret is set. Host blocks cloud egress; user runs ingestion from residential network. Full activation runbook in [`GenomeAsia_config.md`](GenomeAsia_config.md).
- **AI synopsis**: Worker `POST /api/ai/synopsis` + Workbench `<AiSynopsis>` component. Anthropic Claude (default haiku, configurable). Routes via Cloudflare AI Gateway when configured. Result cached per (caseId, variantId) in localStorage. System prompt locks model to clinical-narrative role; user prompt structures evidence so model can't invent AFs or criteria. Prefixed `AI-DRAFTED · REVIEW BEFORE SIGNING ·` in-band.
- **mygene batch interface fix**: discovered while testing pre-flight — the old `q=symbol:A OR symbol:B` OR-Lucene query was silently returning `[{notfound: true}]` for every gene. Switched to documented batch interface `q=A,B,C&scopes=symbol`. OMIM IDs were actually coming from myvariant's dbnsfp.omim overlay path the whole time, not from mygene (the exception was being swallowed).
- **Permissive sample-name matcher**: clinical lab filenames like `DOE-JOHN_GM00020390_proband_S1` now auto-pass via synonyms + abbreviations + terminal `_P/_F/_M` suffixes considered across both VCF header sample AND filename.

### 2026-05-28 (later) — Auth enforcement + report richness
- **Worker-side Clerk JWT** validation (`auth.ts`, `jose` + JWKS); `clerkAuthGated` middleware on `*` with `isPublicPath()` bypass for HMAC webhooks + `/health`
- SPA `apiFetch` wrapper attaches Clerk JWT to every `/api/*` call. Swept all call sites: HpoSearch, RunMonitor, Dashboard, Intake, Workbench, **caseData.loadCase**, **Intake upload-url presign**
- **HPO definitions** plumbed Intake → manifest → case.json (`HPOTerm.definition`) → Report page 1 table + per-variant phenotype list
- **Gene function via mygene.info** — `gene_info: dict[symbol → GeneInfo]` at case level; NCBI Entrez summary paragraph; replaces broken OMIM-only call (the old OR-Lucene query was silently returning `[{notfound: true}]` for every gene). Fixed to proper batch interface `q=A,B,C&scopes=symbol`
- **Expanded predictors** — `PredictorScores` adds SIFT / PolyPhen2 HVAR / PolyPhen2 HDIV / MutationTaster / LRT / FATHMM / PROVEAN / MetaSVM / MetaLR / VEST4 (plus phyloP/GERP). Report `PredictorTable` renders each with Damaging/Tolerated call using native direction (SIFT low=damaging, etc.). Variants cache key v6→v7
- **Singleton/duo workbench banner** with explicit ACMG limitations per mode
- **Het inherited** inheritance model (proband het from unaffected parent — most rare hets land here)
- **Path-filter CI** live via dorny/paths-filter; engine deploy skipped on SPA-only commits
- **Engine lint debt cleared** — `ruff check src tests` clean
- **Permissive sample-name matcher** in vcfSniff — synonyms (dad/papa/sire→father; mom/mama/dam→mother; child/patient/index→proband) + abbrevs (prob/fath/moth) + p1/f1/m1 markers + _P/_F/_M terminal suffixes + filename considered alongside VCF header sample
- **R2 CORS** broadened to `*` (security boundary is the sigv4 presigned URL, not origin)
- Auth fully active in prod: `CLERK_ISSUER` Worker secret + `VITE_CLERK_PUBLISHABLE_KEY` GHA Variable (publishable keys are public so they go in Variables not Secrets)
- Bug fixes: Intake upload-url was still bare `fetch` (401'd); caseData.loadCase was still bare `fetch` (workbench wouldn't load after run); mygene batch interface

### 2026-05-28 (earlier) — Report polish + UX home/pipelines
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
