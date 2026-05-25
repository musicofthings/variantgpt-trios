# VariantGPT — Trio Variant Interpretation Platform
## Product & Technical Requirements (PRD + TRD)

> **Brand:** *VariantGPT* — the platform bridges European-weighted reference databases and the South Asian phenotype, the gap that motivates it.
> **Audience for this document:** Claude Code (build agent). Companion document: `VariantGPT_Frontend_Design_Spec.md` (for the design agent).
> **One‑line:** A Franklin‑class germline trio/family variant interpreter that runs ACMG/AMP point‑based classification and then **re‑scores every VUS against South Asian allele‑frequency baselines**, with mandatory human sign‑off.

---

## 0. How to use this document
Build in the milestone order in §9. The deterministic ACMG engine is the product's spine — implement and test it against truth sets **before** wiring the UI or the LLM layer. The LLM never decides classifications; it only does NLP and drafting (§4.8). Every automated reclassification is a *proposal* requiring a human decision that is logged (§4.10).

---

## 1. Overview & goals
**Problem.** ACMG/AMP frequency criteria (BA1, BS1, PM2) are calibrated on predominantly European reference data. For Indian probands this systematically misfires: variants common in Indian endogamous groups look "rare/absent" in gnomAD‑global and wrongly accrue PM2; truly benign founder variants stay stuck as VUS. The result is an inflated, population‑biased VUS burden.

**Goal.** Replicate Franklin's trio interpretation surface (joint genotype reasoning → inheritance modeling → multi‑database annotation → ACMG point classification → ranked, reportable output) but (a) faster via local/edge architecture, (b) more transparent via a full per‑variant evidence ledger, and (c) materially better for Indian patients via a dedicated South Asian VUS‑reclassification engine.

**Non‑goals (v1).** Somatic/oncology workflows; CNV/SV calling (CNV *classification* is a v2 stretch); primary read alignment (input is VCF, post‑calling); issuing clinical diagnoses (research‑use, human‑signed).

**Success metrics.**
- Concordance with ClinVar 2‑star+ on a benchmark set ≥ 90% for P/LP/B/LB (VUS excluded from concordance, measured separately).
- On a held‑out Indian cohort, demonstrate net VUS reduction (VUS→LB or →LP) with a documented, criterion‑level rationale for each move.
- Trio WES end‑to‑end (engine) in < 10 min on an 8‑core box; interactive edge actions < 2 s p90.

---

## 2. Users & use cases
| User | Primary use |
|---|---|
| Clinical geneticist / molecular pathologist | Review a trio case, adjudicate VUS, sign and export a report |
| Bioinformatician | Run the engine on new cases, manage annotation tracks, tune thresholds |
| Genetic counsellor | Read interpretation, understand inheritance and recurrence implications |
| Researcher | Cohort reclassification studies, evidence audit |

Core journey: create case → build pedigree + enter HPO/clinical history → upload VCFs → engine runs → reviewer works the prioritized variant list → adjudicates VUS in the reclassification panel → signs → exports report.

---

## 3. Scope
**In (v1):** SNVs + small indels; generalized pedigrees (≥1 proband, 0–N relatives); GRCh37 and GRCh38 inputs with auto‑detect + liftover; ACMG/AMP point‑based classification; South Asian reclassification; HPO‑driven prioritization; LLM assist (bounded); PDF/JSON/TSV report; audit log + e‑sign.
**Out (v1):** CNV/SV, mitochondrial heteroplasmy modeling, pharmacogenomics star‑alleles, repeat expansions. (Track as v2.)

---

## 4. Functional requirements

### 4.1 Case intake
- **Pedigree builder.** Add family members; set relationship, sex, and **affected status per member** (affected / unaffected / unknown). Support: classic trio (default), quad/sib‑ships, affected parent(s), consanguinity flag (parents related), and missing members (e.g., duo with one parent). Persist as a pedigree graph (store as PED + JSON).
- **Phenotype (required).** HPO term entry via autocomplete against the current HPO release; at least one HPO term required to proceed. Show term + ID chips; allow removal.
- **Clinical history (required, free text).** Captured per proband. The LLM extracts candidate HPO terms from this text (§4.8) and surfaces them for the curator to accept/reject — accepted terms join the HPO set. Also capture: age of onset, consanguinity notes, prior testing, family history narrative.
- **VCF upload.** One VCF per member, mapped to pedigree roles. Accept bgzipped + tabix or plain VCF. Validate sample names; let the user map VCF sample → pedigree member if names don't match.

### 4.2 Build detection & harmonization
- Auto‑detect reference build from VCF header (`##contig` lengths / `##reference`); if ambiguous, infer from coordinate spot‑checks against build‑specific markers; else prompt.
- **Canonicalize on GRCh38.** Liftover GRCh37 inputs (UCSC/CrossMap chain). Variants that fail to lift are **flagged and retained in a "lift‑failed" bucket**, never silently dropped.
- Normalize: `bcftools norm -m- -f <ref>` (split multiallelics, left‑align, trim). Standardize chromosome naming (`chr` prefix consistency).

### 4.3 Trio/family joint analysis & inheritance modeling
- Merge member VCFs into a joint genotype matrix keyed by normalized variant.
- **QC:** per‑sample call rate, mean depth, transition/transversion; **Mendelian error rate** (flag samples with elevated error → possible sample swap); **sex check** from X/Y; **relatedness/identity** sanity check (e.g., KING‑robust kinship or simple IBS) to confirm the stated pedigree; **contamination** heuristic from het‑allele‑balance distribution.
- **Inheritance model assignment per variant**, evaluated against the pedigree's affected/unaffected structure (generalized, not trio‑locked):
  - *De novo* — present in proband, absent in both parents (with parental depth/quality gating to suppress false de novos; flag low‑confidence).
  - *Autosomal recessive homozygous* — hom‑alt in affected, het in unaffected parents.
  - *Compound heterozygous* — two het variants in the same gene in the affected, **phased by parental origin** (one from each parent), or one inherited + one de novo. Implement a "tree compound" pass that resolves trans configuration from parental genotypes.
  - *Autosomal dominant inherited* — het in affected, transmitted from an affected parent (uses affected‑status of relatives).
  - *X‑linked recessive / dominant*, *Y‑linked*, *mitochondrial* (genotype‑level flag).
  - *Segregation* across additional relatives where present (drives PP1/BS4, §7).
- Emit, per variant, the set of consistent inheritance models + a confidence flag (incorporating depth, allele balance, and de‑novo false‑positive probability).
- Also produce the **Family Carrier output** (parental carrier pairs in the same gene, AR/unknown, het, high/medium confidence, depth>20) as a separate exportable table.

### 4.4 Annotation layer
For every candidate variant, gather:
- **Functional/molecular:** gene, transcript (MANE Select default), HGVS c./p., consequence, exon/intron, via VEP (offline cache) or ANNOVAR. Domain/region overlap (UniProt/InterPro) for PM1.
- **Clinical assertions:** ClinVar (classification, review status/stars, submission conditions), HGMD if licensed, ClinGen (gene‑disease validity, dosage, VCEP specs where present).
- **Population frequency (multi‑ancestry):**
  - gnomAD v4 (genome+exome), **all ancestries incl. `sas`**, via live GraphQL (§6.7) and/or local track.
  - **IndiGenomes** (GRCh38, ~55M variants, AF/AC/AN/het/hom) — local tabix track.
  - **GenomeAsia 100K** (South/SE Asian pilot) — local tabix track.
  - **GenomeIndia** — optional drop‑in track once an IBDC/FeED‑approved AF extract is provided (build the connector now, data later).
- **In‑silico predictors (precomputed tables, no GPU):** AlphaMissense, REVEL, CADD, SpliceAI, plus dbNSFP aggregate; PhyloP/GERP conservation.
- **Phenotype:** gene→disease→HPO associations (HPO/OMIM/Orphanet) for prioritization and PP4.

### 4.5 ACMG/AMP point‑based classification engine
- Implement the **ClinGen SVI Bayesian point system** (Tavtigian transform): each criterion contributes signed points by strength — Pathogenic Supporting/Moderate/Strong/VeryStrong = +1/+2/+4/+8; Benign Supporting/Strong = −1/−4; Stand‑alone benign handled separately. Sum → tier:
  - ≥ +10 Pathogenic; +6..+9 Likely Pathogenic; 0..+5 (with no benign dominance) VUS; −1..−6 Likely Benign; ≤ −7 Benign. (Make thresholds config‑driven.)
- **Criterion strengths must be tunable** (per gene/VCEP override table). Default to ClinGen SVI‑modified strengths for PVS1, PS2/PM6, PS3/BS3, PM2 (→ Supporting), PP3/BP4 (calibrated).
- See §7 for the exact criterion→evidence mapping and what is auto vs. curated.
- Output a **full evidence ledger** per variant: every criterion considered, fired/not, strength, the data point that triggered it, and the source. This ledger is the product's transparency differentiator and the input to the UI's evidence panel.

### 4.6 South Asian VUS reclassification engine
Runs **only on variants the baseline engine calls VUS** (and optionally on conflicting ClinVar VUS).
1. **Frequency recalibration.** Re‑fetch AF from gnomAD `sas`, IndiGenomes, GenomeAsia, GenomeIndia(if present). Recompute frequency criteria against **population‑appropriate thresholds**:
   - **BA1 / BS1** fire if the variant is common in *any* South Asian source above the (gene‑specific, else default) threshold even when gnomAD‑global says rare → pushes toward Benign/Likely Benign.
   - **PM2 retraction**: if present at meaningful AF in a South Asian source, PM2 is removed (it was a false "rare/absent" artifact of European‑weighted data).
   - **Founder‑pathogenic signal**: absent globally but enriched in a specific Indian subgroup *with phenotype concordance* strengthens, not weakens, the pathogenic case — surface as a flag for curator review (do not auto‑upgrade on frequency alone).
2. **Recompute points** with the recalibrated criteria; compute the **point delta** vs. baseline and the resulting tier.
3. **Emit a reclassification proposal**: `VUS → Likely Benign` (or LP), the specific criteria that changed, the AF values and source per population, and the delta. **Never auto‑commit** — write as a proposal awaiting human decision (§4.10).
4. Reproducibility: snapshot the exact track versions/build and gnomAD dataset id used, stored with the proposal.

### 4.7 Phenotype‑driven prioritization
- Rank candidate variants by an integrated score combining: inheritance‑model consistency with the pedigree, gene‑disease validity, variant deleteriousness (predictors), ClinVar evidence, **and HPO semantic similarity** between the proband's terms and each gene's associated phenotypes (Exomiser‑style / Phrank / Resnik). HPO is mandatory, so this signal is always available.
- Drives the default sort in the workbench and PP4 application (§7).

### 4.8 LLM assist layer (bounded)
The LLM does NLP and drafting only; it has **no authority over classification**:
- **HPO extraction** from free‑text clinical history → candidate terms for curator confirmation.
- **Evidence summarization**: condense ClinVar submission text and (optionally, via PubMed connector) literature into a short, sourced synopsis per variant.
- **Narrative drafting**: turn the deterministic evidence ledger into a human‑readable interpretation paragraph for the report (clearly marked AI‑drafted, curator‑edited).
- **Guardrails:** structured JSON I/O; pinned model; no fabrication (must cite the ledger field or source it summarized; if absent, say so); temperature low; every call logged via AI Gateway with model+provider+params (§6.7).

### 4.9 Reporting & export
- **Clinician report (PDF):** case + pedigree summary, HPO, prioritized findings with classification + tier rationale, reclassification proposals and decisions, methods/limitations, track versions, signatory block.
- **Research export (TSV + JSON):** every variant with the full evidence ledger, all population AFs, predictor scores, inheritance models, baseline + reclassified tier and delta.
- Reports are research‑use, human‑signed; include an explicit non‑diagnostic disclaimer.

### 4.10 Audit & human sign‑off
- Every reclassification proposal requires an explicit curator **Accept / Reject / Modify** with optional note; persist who/when/what‑changed.
- Immutable audit log of all curator decisions and report signings (append‑only table).
- No VUS→LP/LB tier appears in a signed report without a recorded human decision.

---

## 5. Non‑functional requirements
- **Performance:** engine trio WES < 10 min (8 cores); edge interactive actions < 2 s p90; live gnomAD re‑query batched + cached.
- **Privacy/security:** genomic data is sensitive. VCFs and reports stored in R2 with per‑case access scoping; D1 holds metadata + decisions, not raw genotypes beyond the candidate set. No PII in URLs. Auth required (see §6). Region‑pin storage where feasible. Provide a "delete case" that purges R2 + D1 (purge is user‑initiated only).
- **Reproducibility:** pin all DB/track versions, reference build, predictor versions, model+params per case; record in the report.
- **Compliance posture:** research‑use‑only framing throughout; no auto‑diagnosis; designed so a future clinical‑validation track (e.g., lab accreditation) can layer on, but not claimed in v1.
- **Accessibility:** colorblind‑safe ACMG tier encoding (never color alone), keyboard navigable (see design spec).

---

## 6. Technical architecture

### 6.1 Topology
```
            ┌─────────────────────────────────────────────┐
   Browser  │  Cloudflare Pages (SPA frontend)            │
   ───────► │  — case dashboard, intake, workbench, report │
            └───────────────┬─────────────────────────────┘
                            │  HTTPS (JSON)
            ┌───────────────▼─────────────────────────────┐
            │  Cloudflare Workers (edge API)               │
            │  — case CRUD, live gnomAD re-query,          │
            │    reclassification recompute, LLM orchestr. │
            └───┬───────────────┬───────────────┬──────────┘
                │               │               │
        ┌───────▼──┐    ┌───────▼──────┐  ┌─────▼───────────┐
        │ D1 (SQL) │    │ R2 (objects) │  │ AI Gateway      │
        │ cases,   │    │ VCFs, tracks │  │ → OpenRouter /  │
        │ variants,│    │ (tabix-over- │  │   Workers AI    │
        │ decisions│    │  HTTP), reports│ └─────────────────┘
        └──────────┘    └──────────────┘

   Heavy genomics (off-edge):
        ┌──────────────────────────────────────────────────┐
        │ Python engine — Colab notebook OR container OR     │
        │ GitHub Action. Parses/normalizes/joins VCFs,       │
        │ inheritance modeling, bulk annotation, ACMG points,│
        │ reclassification. Emits case.json + candidate set  │
        │ → uploaded to R2/D1.                                │
        └──────────────────────────────────────────────────┘
```

### 6.2 Why this split
Cloudflare Workers cannot parse gigabyte WGS VCFs (CPU/memory limits) — so the heavy, batch genomics runs in a **Python engine** off‑edge, and the edge hosts the **interactive layer**. The engine produces a compact annotated candidate set; the Worker serves it, re‑queries live frequencies on demand, recomputes reclassification when the curator changes a threshold, and orchestrates the LLM. This keeps the UI fast and the genomics in the ecosystem (Python) where the tooling actually lives.

### 6.3 Components
- **`engine/` (Python 3.11+):** cyvcf2/pysam for VCF, `bcftools` (subprocess) for norm, CrossMap for liftover, VEP offline or ANNOVAR for annotation, pandas/polars for tables, tabix tracks for population DBs. Packaged as a CLI (`variantgpt-engine run --ped … --vcf … --hpo … --out case.json`) and importable library. Runs in Colab (CPU/RAM is sufficient; GPU optional, see §6.4) or any container.
- **`app/web/` (frontend SPA):** see design spec. Builds to static assets on Pages.
- **`app/api/` (Workers, TypeScript):** Hono router. Endpoints in §6.6.
- **Infra:** D1, R2, AI Gateway, Wrangler config; GitHub Actions for CI + deploy.

### 6.4 GPU note
Core pipeline is **not GPU‑bound**: all predictors (AlphaMissense, SpliceAI, CADD, REVEL) are consumed as **precomputed score tables**. Use Colab's free CPU/high‑RAM runtime to run the engine on WGS‑scale cases. GPU is only relevant if you later add **on‑the‑fly SpliceAI** for novel indels absent from precomputed sets — make that an optional engine flag (`--spliceai-live`) gated behind GPU availability.

### 6.5 Data model (D1)
```
cases(id, name, created_at, build, status, signed_by, signed_at)
members(id, case_id, role, sex, affected, vcf_r2_key, sample_name)
hpo_terms(id, case_id, hpo_id, label, source)         -- source: manual | llm_confirmed
clinical_history(case_id, text, onset_age, consanguinity, prior_testing)
variants(id, case_id, chrom, pos, ref, alt, gene, hgvs_c, hgvs_p,
         consequence, transcript, inheritance_models_json,
         baseline_tier, baseline_points, reclass_tier, reclass_points,
         reclass_delta, priority_score)
evidence(id, variant_id, criterion, fired, strength, source, detail)
populations(id, variant_id, source, ac, an, af, n_hom, n_het)  -- per DB
predictors(variant_id, alphamissense, revel, cadd, spliceai, ...)
reclass_proposals(id, variant_id, from_tier, to_tier, changed_criteria_json,
                  af_evidence_json, snapshot_versions_json, status)  -- status: pending|accepted|rejected|modified
decisions(id, proposal_id, curator, action, note, decided_at)       -- append-only
audit_log(id, case_id, actor, action, payload_json, at)             -- append-only
```
Raw genotypes beyond the candidate set live only in R2 VCFs, not D1.

### 6.6 API contract (Workers)
```
POST   /cases                      create case (metadata)
POST   /cases/:id/members          add member + presign R2 upload for VCF
POST   /cases/:id/hpo              add/confirm HPO terms
POST   /cases/:id/clinical         save clinical history; returns LLM-extracted HPO candidates
POST   /cases/:id/run              trigger engine (enqueue; engine pulls VCFs from R2, writes case.json back)
GET    /cases/:id                  case + status
GET    /cases/:id/variants         prioritized variant list (filter: inheritance_model, tier, gene)
GET    /variants/:id               full evidence ledger + populations + predictors
POST   /variants/:id/requery-freq  live gnomAD sas + track re-query → recompute reclass proposal
POST   /proposals/:id/decision     accept|reject|modify (writes decisions + audit_log)
POST   /variants/:id/narrative     LLM-drafted interpretation (returns draft, never auto-saves)
POST   /cases/:id/report           generate PDF/JSON/TSV → R2; returns presigned URL
```
All mutating endpoints require auth; reclassification decisions and signings write to the append‑only logs.

### 6.7 LLM integration (OpenRouter via AI Gateway)
- Route OpenRouter through **Cloudflare AI Gateway** for caching, rate‑limit, retries, and a logged request/response trail (audit + reproducibility).
- **Pin the model** (config/env), e.g. a strong reasoning model for narrative/summarization and a cheaper model for HPO extraction. Set OpenRouter **provider routing constraints**: `allow`/`order` allowlist, `quantizations` preference (avoid silent INT4 on the reasoning model), and `min throughput`/`max latency` percentile thresholds — but **disable uncontrolled model fallback** so output semantics can't change silently between runs of the same case.
- Log per call: model, resolved provider, params, prompt hash, token counts — store reference in `audit_log`. (Do not store raw genomic identifiers in prompts beyond what's necessary; prefer passing the ledger fields, not the patient's full VCF.)
- All LLM outputs are structured JSON, parsed defensively; on parse failure, surface "AI assist unavailable," never block the deterministic result.

### 6.8 Repo layout & deploy (GitHub + Cloudflare + Colab)
```
variantgpt/
  engine/            # Python: CLI + library + tests
  app/
    web/             # SPA → Cloudflare Pages
    api/             # Workers (Hono, TS) → Cloudflare Workers
  tracks/            # ingestion scripts: IndiGenomes/GenomeAsia → bgzip+tabix → R2
  notebooks/         # Colab: run engine on a case end-to-end
  infra/             # wrangler.toml, D1 migrations, R2 buckets, AI Gateway config
  data/test/         # GIAB trio + curated benchmark variants
  .github/workflows/ # CI (engine pytest, web build) + deploy (Pages + Workers)
```
- **CI:** run engine unit + truth‑set tests; build web; lint Workers.
- **Deploy:** GitHub Actions → `wrangler deploy` (Workers) + Pages build; D1 migrations on release.
- **Tracks:** `tracks/` scripts ingest the academic‑use IndiGenomes/GenomeAsia downloads, bgzip+tabix, and upload to R2; Workers query them via HTTP range requests (tabix‑over‑HTTP). GenomeIndia AF slots in the same way once you obtain an IBDC/FeED extract.

---

## 7. Algorithms — ACMG criterion mapping
**Trio‑derived criteria are a core strength** (Franklin‑parity + transparency):

| Criterion | Auto? | How VariantGPT evaluates it |
|---|---|---|
| PVS1 | Auto* | Predicted LoF (nonsense/frameshift/canonical splice/init/exon‑del) in a gene where LoF is the known mechanism; apply ClinGen PVS1 decision‑tree strength modulation (last‑exon/NMD escape downgrades). *Curator can override. |
| PS1 | Auto | Same amino‑acid change as an established pathogenic variant (different nucleotide) in ClinVar/HGMD. |
| PS2 / PM6 | **Auto (trio)** | Confirmed de novo (parentage‑supported) → PS2; assumed de novo (parentage unconfirmed) → PM6. Strength scaled by phenotype consistency. |
| PS3 / BS3 | Curated | Functional study evidence — surfaced from literature/ClinVar for curator entry. |
| PS4 | Curated | Case‑control/prevalence — curator entry (LLM may summarize literature). |
| PM1 | Auto* | Variant in a well‑characterized mutational hotspot/functional domain lacking benign variation. |
| PM2 | Auto | Absent/rare in population DBs — **and re‑evaluated against South Asian baselines in §4.6** (default Supporting per SVI). |
| PM3 | **Auto (trio)** | For recessive genes, variant detected **in trans** with a (likely) pathogenic variant — resolved from parental phasing in the compound‑het pass. |
| PM4 | Auto | Protein length change (in‑frame indel / stop‑loss) in non‑repeat region. |
| PM5 | Auto | Novel missense at a residue where a different pathogenic missense is established. |
| PP1 / BS4 | **Auto (pedigree)** | Co‑segregation with disease across affected/unaffected relatives where present; strength scales with informative meioses. |
| PP2 | Auto | Missense in a gene with low rate of benign missense + missense‑is‑mechanism. |
| PP3 / BP4 | Auto | In‑silico concordance using **ClinGen‑calibrated thresholds** (AlphaMissense/REVEL/CADD + SpliceAI); calibrated strength, not flat Supporting. |
| PP4 | Auto* | Phenotype highly specific for the gene — driven by HPO semantic match (§4.7); curator confirms. |
| BA1 / BS1 | Auto | Allele frequency above (gene‑specific else default) thresholds — **re‑evaluated against South Asian baselines (§4.6)**. |
| BS2 | Auto | Observed in healthy adults inconsistent with penetrance (uses population hom/het counts incl. South Asian). |
| BP2 | **Auto (trio)** | Observed in cis with a pathogenic variant / in trans for a dominant disorder — from phasing. |
| BP7 | Auto | Synonymous/intronic with no predicted splice impact and conserved‑site clear. |
| PP5 / BP6 | Not used | Deprecated by ClinGen SVI. |

`*` = auto‑proposed, curator can override strength or applicability. Each criterion writes an `evidence` row with its triggering data point and source.

**Reclassification recompute (concise):** baseline tier from the point sum; if VUS, run §4.6 frequency recalibration → adjusted criteria set → new point sum → if tier crosses a boundary, emit a `reclass_proposal` with the changed criteria, the per‑population AF evidence, and the point delta. Curator decision required to commit.

---

## 8. Acceptance criteria / test plan
- **Truth sets:** GIAB trio (HG002/3/4) for inheritance‑logic correctness (de novo, comp‑het, Mendelian checks); a curated ClinVar 2‑star+ benchmark for classification concordance; synthetic pedigrees for non‑trio configurations (affected parent, sib‑ship, consanguinity, missing member).
- **Engine tests:** build detection + liftover (round‑trip a known set); normalization idempotence; each inheritance model on hand‑built cases; each ACMG criterion on positive + negative fixtures; point‑sum boundary tests.
- **Reclassification tests:** seed variants known to be common in IndiGenomes/gnomAD‑sas but rare global → assert PM2 retraction / BS1 application and a VUS→LB proposal; assert no auto‑commit.
- **Edge tests:** API contract; live gnomAD re‑query + recompute; decision logging is append‑only; report contains version snapshot + disclaimer.
- **LLM tests:** HPO extraction precision on annotated histories; narrative cites only ledger fields; graceful degradation on provider failure.

---

## 9. Build order (milestones)
1. **Engine core:** intake parsing, build detect/liftover, normalize, joint merge, QC (Mendelian/sex/relatedness). Test on GIAB trio.
2. **Inheritance modeling** (generalized pedigrees) + Family Carrier output.
3. **Annotation layer:** VEP/ANNOVAR + ClinVar + gnomAD(sas) + IndiGenomes/GenomeAsia tracks + predictor tables + HPO associations.
4. **ACMG point engine** + evidence ledger. Concordance test.
5. **South Asian reclassification engine** + proposals + snapshots. Reclass tests.
6. **HPO‑driven prioritization.**
7. **Edge app:** D1/R2/Workers API, case CRUD, run orchestration, variant list/detail, live re‑query, decisions + audit, report generation.
8. **LLM assist** via AI Gateway → OpenRouter (HPO extraction, summaries, narrative), pinned + logged.
9. **Frontend** per design spec (can proceed in parallel from step 7's contract).
10. **GenomeIndia connector** wired (data when available); polish, docs, Colab notebook.

---

## 10. Risks & open questions
- **GenomeIndia access is gated** (FeED/IBDC) — connector built now, data later; v1 ships without it.
- **Track licensing:** IndiGenomes/GenomeAsia are academic‑use; confirm terms for any non‑academic deployment.
- **Liftover loss:** some GRCh37 variants won't lift — surfaced, not dropped; quantify on the benchmark.
- **WGS at the edge:** very large cases must run via the engine (Colab/container); the edge never parses raw WGS.
- **Reclassification safety:** frequency alone never auto‑upgrades to pathogenic; founder‑pathogenic is a flag for human review, not an automated call.
- **Open question for you:** default gene‑specific frequency thresholds — adopt ClinGen VCEP thresholds where they exist and fall back to BA1 0.05 / BS1 disease‑prevalence‑derived (else 0.01)? Confirm or supply your preferred defaults.
