# VariantGPT — Cloudflare deploy playbook

End-to-end stack:
```
Pages (variantgpt-web)         ← React SPA, static build
   │ HTTPS
Worker (variantgpt-api)         ← Hono routes, /api/*
   ├── D1 (variantgpt)          ← cases, members, jobs, uploads, evidence, ...
   ├── R2 (variantgpt)          ← uploaded VCFs, generated case.json, reports
   └── Container (EngineContainer) ← Python engine, engine/Dockerfile
```

Prereqs: `wrangler` 3.78+ logged into the right Cloudflare account, Docker installed locally so wrangler can build the container image.

## 1. Create the D1 database

```powershell
cd app/api
wrangler d1 create variantgpt
# Copy the returned database_id into app/api/wrangler.toml (replace REPLACE_WITH_D1_ID).
wrangler d1 migrations apply variantgpt --remote
```

## 2. Create the R2 bucket + access keys

```powershell
wrangler r2 bucket create variantgpt
# Then in the Cloudflare dashboard → R2 → Manage R2 API Tokens, mint a
# token with Object Read & Write on the bucket. Copy the keys.
```

## 3. Set Worker secrets

```powershell
cd app/api
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_ACCOUNT_ID            # your CF account ID
wrangler secret put ENGINE_WEBHOOK_SECRET    # any random 32+ char string
# Optional, once the LLM features land:
# wrangler secret put OPENROUTER_API_KEY
```

## 4. Deploy the Worker (builds + pushes the container image too)

```powershell
cd app/api
npm install
wrangler deploy
```

First deploy can take 3-5 minutes — wrangler builds the Docker image from `engine/Dockerfile`, uploads it to the Cloudflare Container Registry, and provisions the Durable Object class.

## 5. Deploy the SPA to Pages

```powershell
cd app/web
$env:VITE_API_BASE = "https://variantgpt-api.<your-subdomain>.workers.dev"
npm install
npm run build
npx wrangler pages deploy dist --project-name=variantgpt-web
```

## 6. Smoke test

1. Open the Pages URL.
2. New case → drop the three demo VCFs (`data/test/demo_trio/*.vcf`) into the corresponding pedigree members.
3. Run. The RunMonitor should advance queued → running → ready in ~30s (most of that is cold container start; subsequent runs in the same 5 minutes reuse the warm container).
4. Open the case and confirm 11 variants render with tiers + 1 MEFV reclassification.

## Troubleshooting

- **Container fails to start** — check `wrangler tail` logs. The most common cause is the Dockerfile failing to pip-install on the build container. Pin Python version in the FROM line if needed.
- **Presigned PUT returns 403** — the R2 sigv4 client uses the keys from secrets; double-check `R2_ACCOUNT_ID` matches the subdomain of your R2 endpoint. The bucket name in api.ts is hardcoded to `variantgpt` — change if you used a different name.
- **`/api/cases/:id/status` always shows queued** — the callback HMAC must match. Confirm `ENGINE_WEBHOOK_SECRET` is set as a secret (not a var) and that the container sees it via the run-payload's `callback_secret` field.
- **Stale demo data** — the SPA still serves `/demo/case.json` directly from Pages for caseId `demo-trio-001`. Rebuild it with `python tracks/build_demo_case.py` before deploying.
