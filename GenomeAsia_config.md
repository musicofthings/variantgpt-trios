# GenomeAsia 100K — Activation Guide

Step-by-step setup to add GenomeAsia 100K allele frequencies to the VariantGPT South-Asian reclassification pipeline.

**Status:** the engine adapter, ingestion CLI, and Worker URL-signing are all already deployed. This guide describes how to get the upstream data into your R2 bucket and flip the switch.

**Why this is a manual step:** `browser.genomeasia100k.org` blocks every cloud egress IP we've tested (Fly.io, Cloudflare Workers, AWS, GCP all observed timing out). The composite VCFs are publicly browsable per the Nature 2019 paper, but downloads only complete from residential / VPN'd / institutional networks. Once the data lands in R2, the engine reads from R2 normally.

---

## Prerequisites

You'll need:

- A network that can reach `browser.genomeasia100k.org` (your laptop on home internet, a VPN, an institutional VM, etc.)
- ~30 GB of free disk for the raw downloads + the converted TSVs
- Python 3.11+ (3.12 / 3.14 also fine) — used by the ingestion CLI
- `wrangler` CLI authenticated to the Cloudflare account that owns the `variantgpt` R2 bucket (`npx wrangler login` once)
- `wget` or `curl` on your local machine for the bulk download
- Optionally `md5sum` (macOS: `md5`) for integrity checking before ingestion

The ingestion script has no Python dependencies beyond the standard library — no need to install anything else.

---

## Step 1 — Download the composite VCFs

Run this in a terminal **on a network that can reach the host** (NOT the Fly engine; NOT a Cloudflare Worker — those are blocked):

```bash
mkdir -p GA100K && cd GA100K

BASE=https://browser.genomeasia100k.org/service/web/download_files

# Chromosomes 1–22 substitutions (SNVs + small indels in the substitution file)
for i in {1..22}; do
  wget -c --no-check-certificate "$BASE/${i}.substitutions.annot.cont_withmaf.vcf.gz"
done

# Indels (all chromosomes in one file)
wget -c --no-check-certificate "$BASE/All.indels.annot.cont_withmaf.vcf.gz"

# Integrity manifest
wget -c --no-check-certificate "$BASE/md5sum.info.txt"
```

Notes:

- `wget -c` resumes interrupted downloads — useful since some of the chromosome files are several GB.
- `--no-check-certificate` is needed because the host's SSL chain has been intermittently broken.
- The 22 chromosome files plus the indel file are the **complete** GenomeAsia composite track. You do NOT need the `coriell_samples.*` files (those are sample-level data and require a Data Access Agreement).
- Expected total download size: ~10–20 GB depending on which version is currently published.

If a chromosome download stalls or returns 502, retry — the site has been intermittently flaky. The `-c` flag picks up where it left off.

---

## Step 2 — Verify integrity (optional but recommended)

The ingestion CLI will auto-verify against `md5sum.info.txt`, but you can also check manually:

```bash
# From inside the GA100K directory:
md5sum -c md5sum.info.txt 2>&1 | grep -E "OK|FAILED"
```

If anything reports `FAILED`, re-download that file with `wget -c "$BASE/<filename>"`.

---

## Step 3 — Run the ingestion CLI

The script parses each VCF, extracts the allele-frequency lookup (`chrom \t pos \t ref \t alt \t af \t ac \t an`), gzips it, and uploads to R2.

From the VariantGPT repo root (NOT inside `GA100K/`):

```bash
python tracks/ingest_genomeasia.py \
    --src ./GA100K \
    --bucket variantgpt \
    --r2-prefix tracks/genomeasia/v1
```

Useful flags:

| Flag | Purpose |
|---|---|
| `--skip-validate` | Skip the MD5 check. Use if you've already validated and want to save a minute. |
| `--skip-upload` | Build the TSVs locally only; don't push to R2. Lets you preview output size before uploading. |
| `--out ./out-genomeasia` | Local intermediate directory for the TSVs. Default is `./out-genomeasia`. |
| `--wrangler /path/to/wrangler` | Override the wrangler CLI path if it isn't on `$PATH`. |
| `-v` | Verbose logging (per-file progress). |

Expected output:

```
INFO ingest_genomeasia: converting 1.substitutions.annot.cont_withmaf.vcf.gz → chr1.tsv.gz
INFO ingest_genomeasia:   chr1: 12,345,678 → 12,123,456 rows (a1b2c3d4e5f6, 84.2 MB)
…
INFO ingest_genomeasia:   indels: 8,765,432 → 8,500,123 rows (…)
INFO ingest_genomeasia: manifest: out-genomeasia/manifest.json
INFO ingest_genomeasia: total variants: 182,000,000
INFO ingest_genomeasia: uploading to r2://variantgpt/tracks/genomeasia/v1/
INFO ingest_genomeasia:   PUT tracks/genomeasia/v1/af/chr1.tsv.gz ← af/chr1.tsv.gz (84.2 MB)
…
INFO ingest_genomeasia: done. Set engine env var GENOMEASIA_R2_PREFIX=tracks/genomeasia/v1 to activate the adapter.
```

R2 layout after upload:

```
variantgpt/
└── tracks/
    └── genomeasia/
        └── v1/
            ├── manifest.json          # sha256 + row counts per file
            └── af/
                ├── chr1.tsv.gz        # ~80 MB compressed
                ├── chr2.tsv.gz
                …
                ├── chr22.tsv.gz
                └── indels.tsv.gz
```

Each TSV is sorted by chromosome and contains one row per (ref, alt) allele — multi-allelic sites are split at ingestion.

---

## Step 4 — Tell the Worker the data is live

The Worker reads a secret called `GENOMEASIA_R2_PREFIX`. When it's set, the Worker mints one signed GET URL per chrom file and ships them to the engine on every case run. When it's unset, the engine's GenomeAsia adapter is a silent no-op.

```bash
cd app/api
npx wrangler secret put GENOMEASIA_R2_PREFIX
# When prompted, paste:
tracks/genomeasia/v1
```

Wrangler will confirm: `✨ Success! Uploaded secret GENOMEASIA_R2_PREFIX`.

Verify it's set:

```bash
npx wrangler secret list | grep GENOMEASIA
# → "name": "GENOMEASIA_R2_PREFIX", "type": "secret_text"
```

No redeploy needed — secrets are picked up by the next request the Worker handles.

---

## Step 5 — Verify the pipeline picks it up

Re-run any existing case (or upload a fresh one). In the live engine log on the Workbench banner, you should see a new line after the IndiGenomes stage:

```
GenomeAsia: looking up allele frequencies from R2 tracks
GenomeAsia: chr1 loaded (12,123,456 rows, 84.2 MB)
GenomeAsia: chr11 loaded (8,567,890 rows, 65.1 MB)
…
GenomeAsia: 1,247 variants annotated
```

In the workbench, open a variant detail drawer → **Population frequency** panel. You should now see a `GenomeAsia` lollipop alongside gnomAD-global, gnomAD-SAS, and IndiGenomes.

Reclassification automatically uses the new source because `reclassify.py` already lists `genomeasia` in `SAS_SOURCES` — no engine code change needed. Variants that were previously borderline VUS due to "absent from controls" (PM2) may now reclassify to LB if GenomeAsia shows them at meaningful frequency.

---

## Step 6 — Updating to a newer GenomeAsia release

GenomeAsia occasionally republishes the composite files (per the Nature paper, updates roll out as the cohort grows). To rotate:

1. Download the new files into a fresh local directory (e.g. `GA100K_v2/`).
2. Run ingestion with a **new** R2 prefix to avoid clobbering the old data while the engine is mid-run:
   ```bash
   python tracks/ingest_genomeasia.py --src ./GA100K_v2 --r2-prefix tracks/genomeasia/v2
   ```
3. Update the Worker secret:
   ```bash
   cd app/api && npx wrangler secret put GENOMEASIA_R2_PREFIX
   # paste: tracks/genomeasia/v2
   ```
4. After verifying a fresh run logs `chr1 loaded` etc. from the v2 prefix, you can purge the old files:
   ```bash
   # List the v1 keys to confirm
   npx wrangler r2 object list variantgpt --prefix tracks/genomeasia/v1/
   # Then delete each — wrangler doesn't support recursive delete, so do it via the dashboard or write a one-shot script
   ```

---

## Step 7 — Disabling without removing the data

If you want to switch GenomeAsia off without deleting the R2 objects (e.g. to A/B compare reclassification with and without it):

```bash
cd app/api
npx wrangler secret delete GENOMEASIA_R2_PREFIX
```

The adapter immediately stops firing on the next run. Re-enable by re-running `npx wrangler secret put GENOMEASIA_R2_PREFIX`.

---

## Troubleshooting

### "wget: unable to resolve host browser.genomeasia100k.org"
Confirm you're on a network that can reach the host:
```bash
nslookup browser.genomeasia100k.org
curl -I https://browser.genomeasia100k.org/
```
If DNS or TLS fails, try a different network (mobile hotspot, VPN, etc.). The host actively blocks known cloud IP ranges (AWS, GCP, Cloudflare, Fly).

### Downloads complete but the file is suspiciously small (a few KB)
The site returned its HTML error page instead of the VCF. Delete the file and retry with `wget -c`. Persistent issues = the site is currently failing for everyone; check back later or email `dataaccess@genomeasia100k.org`.

### `python tracks/ingest_genomeasia.py` fails with "MD5 validation failed"
A download was corrupted. The error log names the file. Re-download just that file:
```bash
cd GA100K && wget -c "$BASE/<filename>" && cd ..
```
Then re-run ingestion. Or use `--skip-validate` if you're confident the file is fine (e.g. you've already manually checked).

### Engine log shows `GenomeAsia: lookup failed (continuing without): HTTPStatusError: 403 Forbidden`
The signed URLs minted by the Worker have a 6-hour TTL. If a case run is longer than that (very rare — typical runs are 10–15 min), some chrom files may expire mid-fetch. The engine catches the error and continues with the other AF sources.

If you see this on short runs, the most likely cause is the R2 sigv4 credentials on the Worker don't have read permission for that prefix. Check:
```bash
npx wrangler secret list | grep R2_
# All of R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID should be present
```

### Engine log shows `GenomeAsia: lookup failed (continuing without): JSONDecodeError`
The Worker passed a malformed URL map. This shouldn't happen in practice. If it does, the Worker logs will have details — `npx wrangler tail` to stream them.

### How do I know it's actually being used in reclassification?
Open the workbench → click a reclassified variant → **Evidence ledger** → BS1 row. The "Source" field should now include `genomeasia` when that's the source that drove BS1 firing. The Worker is also configured to surface the highest-AF source in the reclassification proposal.

---

## What's in the R2 storage

After ingestion, the bucket holds ~1.5 GB of compressed TSVs (varies slightly by release). R2's free tier covers 10 GB-month of storage, so this is well within the free band. Egress for engine reads is also free within Cloudflare's network (R2 → Fly is paid egress; R2 → Worker is free, but we're reading directly to Fly — see note below).

**Future optimization:** if R2 egress to Fly becomes material, we can route reads through the Worker (R2 → Worker → Fly), which would be all-CF-internal traffic. Right now the AF tables are small enough (~1.5 GB total) that even monthly full pulls are < $0.05 — not worth the complexity.

---

## References

- [GenomeAsia 100K browser](https://browser.genomeasia100k.org/)
- [The GenomeAsia 100K Project enables genetic discoveries across Asia (Nature 2019)](https://www.nature.com/articles/s41586-019-1793-z)
- [Data Access Agreement form](https://browser.genomeasia100k.org/forms/GA100k-data_access_agreement.v2.pdf) — required only for individual-level VCFs (out of scope for this pipeline, which uses composite AFs only)
- Implementation files in this repo:
  - `tracks/ingest_genomeasia.py` — CLI script
  - `engine/src/variantgpt_engine/annotation_sources/genomeasia.py` — engine adapter
  - `app/api/src/routes/api.ts` — `maybeGenomeAsiaTemplate()` helper
  - `tracks/container_server.py` — pipeline stage wiring
