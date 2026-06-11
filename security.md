# VariantGPT Security & Privacy

VariantGPT processes **human genomic and clinical data**. In many jurisdictions this data is classified as **Protected Health Information (PHI)** under HIPAA (United States) and as **special category personal data** under GDPR (European Union and UK). Treat every case as sensitive unless you have confirmed it is fully de-identified synthetic or public benchmark data.

This document describes **what can go wrong**, **how the system is designed to reduce risk**, and **what operators and contributors must do** before handling real patient material.

> **Compliance posture (v1):** VariantGPT is framed as a **research-use interpretation tool** with mandatory human sign-off. It is **not** marketed or certified as a HIPAA-compliant clinical diagnostic system. Deployments that process real PHI require a formal legal and technical compliance program layered on top of this baseline.

---

## 1. What counts as sensitive data here

VariantGPT routinely stores and processes:

| Category | Examples in VariantGPT | Regulatory sensitivity |
|---|---|---|
| **Genomic identifiers** | VCF/BAM/CRAM files, sample names, chromosomal coordinates, HGVS notation, rsIDs | Often re-identifiable; HIPAA identifier when linked to an individual |
| **Clinical phenotype** | HPO terms, free-text clinical history, onset age, consanguinity, family history | PHI / special category health data |
| **Case metadata** | Proband ID, sex, affected status, pedigree roles, curator decisions, signed reports | PHI when linkable to a person |
| **Derived artifacts** | `case.json`, evidence ledgers, PDF/HTML reports, audit logs | PHI if sourced from identifiable cases |

Even a **small variant subset** plus demographics can be re-identifying. Genomic data is not safely anonymized by removing names alone.

---

## 2. PHI leak risk scenarios

### 2.1 Version control and local development

| Risk | How it happens | Impact |
|---|---|---|
| Committing real VCFs/BAMs | `git add` on upload folders or misconfigured `.gitignore` | Permanent exposure in git history; public repo = critical breach |
| Committing reports or `case.json` | Exporting a signed report into the repo for debugging | Full clinical + genomic narrative leaked |
| Screenshots / notebooks | Colab or Jupyter outputs embedding patient IDs or loci | Uncontrolled duplication outside audit trail |
| MCP / IDE caches | Local tool descriptors or agent sessions referencing case paths | Accidental upload to third-party AI services |

**Mitigations in this repo:**

- `.gitignore` blocks `data/uploads/`, `data/cases/`, `data/raw/`, `*.vcf`, `*.bam`, `*.cram`, and `*.pdf` (with narrow demo exceptions).
- Demo data under `data/test/demo_trio/` is synthetic/benchmark only — never substitute real patient files there.
- Do **not** commit `mcps/` or other IDE-generated MCP caches; they can steer agents toward reading local case directories.

### 2.2 Cloud storage and URLs

| Risk | How it happens | Impact |
|---|---|---|
| Overly long-lived presigned URLs | Sharing upload/download links in chat, tickets, or logs | Anyone with the URL can read/write objects until expiry |
| Case IDs in URLs without auth | Predictable IDs scraped or guessed | Unauthorized case access |
| R2 bucket misconfiguration | Public bucket ACL or missing CORS/auth boundary | Mass data exfiltration |

**Mitigations in this repo:**

- VCFs and reports live in **Cloudflare R2** with **per-case access scoping**; D1 holds metadata and curated variant rows, not full WGS genotypes.
- Presigned URLs are the access boundary — treat them as secrets with minimal TTL.
- **No PII in URLs** is a design requirement (see [VariantGPT_PRD_TRD.md](VariantGPT_PRD_TRD.md)).
- API routes require **Clerk JWT** authentication for mutating operations.

### 2.3 Third-party and AI services

| Risk | How it happens | Impact |
|---|---|---|
| LLM prompt exfiltration | Sending full VCFs, verbose clinical history, or unnecessary variant lists to OpenRouter/Anthropic | PHI processed by a subprocessors without a BAA / DPA |
| HPO extraction | Clinical free-text sent for NLP grounding | Direct PHI in model provider logs |
| Browser Rendering / PDF | Server-side render of reports containing patient blocks | PHI in transient render worker memory |
| External annotation APIs | myvariant.info, VEP REST, gnomAD live re-query with variant coordinates | Indirect disclosure of tested loci |

**Mitigations in this repo:**

- LLM calls route through **Cloudflare AI Gateway** with audit references (model, prompt hash, token counts) — not full prompt text in routine logs.
- Product guidance: pass **ledger fields**, not entire VCFs, into narrative prompts.
- HPO extraction uses a **two-stage** flow (phrase extraction → OLS4 grounding) to reduce fabricated identifiers, but **clinical text still leaves your boundary** — govern accordingly.
- LLM output is **draft-only**; classification and reporting tiers require **human curator decisions** recorded in the append-only audit log.

### 2.4 Engine and operator access

| Risk | How it happens | Impact |
|---|---|---|
| Fly.io engine compromise | Unpatched container, shared SSH keys, debug endpoints left open | Bulk download of all cases staged in R2 |
| Operator workstation | Local copies of VCFs outside encrypted volumes | Loss/theft exposure |
| Log verbosity | Printing sample names, paths, or variant rows in CI or Fly logs | PHI in log aggregators |

**Mitigations:**

- Engine runs **off-edge** on Fly.io; it pulls case VCFs from R2 and writes `case.json` back — limit who can access Fly secrets and R2 credentials.
- Rotate API keys (`BROWSER_RENDERING_TOKEN`, R2 keys, Clerk secrets, OpenRouter keys) on a schedule and after personnel changes.

### 2.5 Incomplete deletion

| Risk | How it happens | Impact |
|---|---|---|
| Partial purge | D1 row deleted but R2 objects remain (or vice versa) | Retained PHI after patient withdrawal |
| Cache stages | Resumable engine caches in R2 (`tracks/cache/`, per-case stages) | Forgotten copies of intermediate genotypes |

**Mitigations:**

- Provide a **user-initiated "delete case"** that purges **both R2 and D1** (see PRD §5).
- After deletion, verify R2 prefixes and engine cache keys for the case are gone.

---

## 3. HIPAA (United States)

HIPAA applies when VariantGPT is used by a **covered entity** or **business associate** to create, receive, maintain, or transmit PHI.

### 3.1 Relevant Safeguard themes

| HIPAA theme | VariantGPT baseline | Gap for clinical production |
|---|---|---|
| **Minimum necessary** | Candidate-set focus in D1; not full WGS in SQL | Operators must still restrict exports and LLM prompts |
| **Access control** | Clerk JWT on API; per-case scoping | Needs org-level RBAC, break-glass policy, MFA enforcement |
| **Audit controls** | Append-only `decisions` + `audit_log` for curation/signing | Needs centralized SIEM, log retention policy, tamper evidence |
| **Integrity** | Human sign-off before reportable tier changes | Needs change-management and backup verification |
| **Transmission security** | HTTPS end-to-end | TLS alone insufficient without BAAs for subprocessors |
| **Breach notification** | Not automated in v1 | Requires incident runbook and legal counsel |

### 3.2 Business Associate Agreements (BAAs)

Before processing real US patient data in production, execute **BAAs** (or equivalent contractual protections) with every subprocessor that may touch PHI, including at minimum:

- Cloudflare (Workers, D1, R2, AI Gateway, Browser Rendering)
- Fly.io (engine host)
- Clerk (authentication)
- LLM providers reached via OpenRouter / Anthropic
- Any external genomics API invoked with case-specific context

**Without signed BAAs, do not upload identifiable patient VCFs to the hosted stack.**

### 3.3 De-identification

HIPAA Safe Harbor or Expert Determination de-identification may allow reduced regulatory burden, but **genomic data is notoriously resistant to de-identification**. Assume re-identification risk unless a qualified statistician has signed off on a specific release dataset.

---

## 4. GDPR & UK GDPR (European Union / United Kingdom)

Genomic + health data is **Article 9 special category data**. Processing requires a lawful basis **and** an Article 9 condition (typically **explicit consent** or **substantial public interest** with member-state law — legal review required).

### 4.1 Data subject rights

| Right | VariantGPT consideration |
|---|---|
| **Access** | Export via report JSON/TSV/PDF; ensure exports are access-controlled |
| **Rectification** | Curator can update clinical history/HPO; genomic calls are analytical facts — document correction workflow |
| **Erasure** | "Delete case" must remove R2 objects, D1 rows, caches, and audit entries per your retention policy |
| **Restriction / objection** | Pause processing flag may be needed for production deployments |
| **Portability** | Structured `case.json` / TSV export supports portability if lawfully requested |
| **Automated decision-making** | Classification is deterministic + human-signed; LLM drafts must not auto-commit |

### 4.2 Cross-border transfers

Cloudflare and Fly.io may process data in **multiple regions**. For EU/UK data subjects:

- Map **where** VCFs, `case.json`, and reports are stored and rendered.
- Use **Standard Contractual Clauses (SCCs)** or UK IDTA/addendum with vendors.
- Prefer **region-pinned storage** where Cloudflare/R2 configuration allows (PRD goal: "region-pin storage where feasible").

### 4.3 Data Protection Impact Assessment (DPIA)

A DPIA is **likely required** before large-scale clinical use because processing is systematic, concerns health/genetic data, and uses novel AI-assisted workflows. Document:

- Purpose and necessity of LLM assists
- Re-identification risk from variant lists
- Subprocessor list and transfer mechanisms
- Retention schedule and deletion verification

### 4.4 Privacy notice and consent

End users (clinicians **and** patients, depending on deployment) need clear notice covering:

- Who is controller vs processor
- What genomic/clinical fields are collected
- Which third parties receive data (including AI providers)
- Retention period and deletion mechanism
- Whether data is used for model training (default: **must be opt-out or prohibited** contractually)

---

## 5. Built-in technical controls (summary)

| Control | Location / mechanism |
|---|---|
| Auth on mutating API routes | Clerk JWT via `app/web/src/auth.tsx` → Worker validation |
| Raw VCFs excluded from git | `.gitignore` |
| Separation of bulk genotypes vs metadata | R2 (VCFs) vs D1 (candidate variants + decisions) |
| Presigned upload/download | R2 sigv4 URLs — short-lived secrets |
| Human gate on reportable changes | `decisions` + `audit_log` tables; no silent VUS→LP promotion |
| LLM bounded to drafting | Narrative/HPO assist; deterministic ACMG engine owns classification |
| AI Gateway logging | Prompt hashes and token counts, not full VCF payloads |
| Case deletion (design) | User-initiated purge of R2 + D1 |

---

## 6. Operator checklist (production with real cases)

1. **Legal** — Confirm controller/processor roles; sign DPAs/BAAs; complete DPIA where required.
2. **Identity** — Enforce MFA on Clerk; restrict curator accounts; no shared logins.
3. **Secrets** — Store keys in Cloudflare/Fly secret managers only; never in `.env` committed files.
4. **Network** — Disable public engine admin endpoints; restrict Fly ingress to Worker IPs if possible.
5. **LLM** — Disable or redact clinical free-text prompts in dev; pin models; block training on customer data in vendor contracts.
6. **Retention** — Define max case lifetime; automate deletion of stale uploads in `data/uploads/`.
7. **Backups** — Encrypt backups; include them in deletion scope; test restore without copying PHI to unsecured environments.
8. **Monitoring** — Alert on anomalous R2 download volume, failed auth spikes, and presigned URL generation rates.
9. **Training** — Staff must not paste patient data into public chat tools, MCP agents, or unapproved notebooks.

---

## 7. Contributor / developer checklist

- [ ] Never commit files matching `*.vcf`, `*.bam`, `*.cram`, or contents of `data/uploads/` / `data/cases/`.
- [ ] Use only `data/test/demo_trio/` fixtures in CI and screenshots.
- [ ] Scrub sample names, proband IDs, and clinical history from bug reports and PR descriptions.
- [ ] Do not run `run_secret_scanning` or similar tools against real case directories.
- [ ] When debugging LLM routes, use synthetic clinical text.
- [ ] Add `mcps/` to `.gitignore` if your IDE generates local MCP descriptors.
- [ ] Report suspected exposure immediately (see §8).

---

## 8. Incident response (baseline)

If you suspect PHI left the trusted boundary (public git push, open bucket, leaked presigned URL, prompt logged by a vendor):

1. **Contain** — Revoke presigned URLs, rotate R2/Clerk/API keys, disable affected case IDs, take engine offline if actively exfiltrating.
2. **Assess** — Identify which cases, fields, and subprocessors were involved; preserve audit logs without copying more PHI into tickets.
3. **Notify** — Engage legal/privacy officer; HIPAA breach notification timelines may apply (typically **60 days** to HHS/individuals depending on scope); GDPR **72-hour** supervisory authority clock may apply.
4. **Remediate** — Purge improperly stored copies; fix misconfiguration; document root cause.
5. **Review** — Update this document, `.gitignore`, and deployment runbooks.

---

## 9. Research-use disclaimer

VariantGPT reports are **research-use, human-signed** outputs with an explicit **non-diagnostic disclaimer**. Security and privacy controls support responsible research workflows; they **do not** by themselves satisfy HIPAA, GDPR, or clinical laboratory accreditation (e.g., CLIA/CAP) requirements for diagnostic use.

For accreditation or diagnostic deployment, plan a separate **clinical validation track** with formal risk management, validated software lifecycle controls, and jurisdiction-specific regulatory filings.

---

## 10. Related documents

- [VariantGPT_PRD_TRD.md](VariantGPT_PRD_TRD.md) — §4.10 Audit, §5 Privacy/security, §6.7 LLM integration
- [infra/DEPLOY.md](infra/DEPLOY.md) — secrets, R2 CORS, D1 migrations
- [.gitignore](.gitignore) — genomic data exclusions
- [HANDOVER.md](HANDOVER.md) — live architecture and data flow

**Questions or suspected vulnerabilities:** open a private security advisory with the repository maintainers rather than a public issue if exposure is active.