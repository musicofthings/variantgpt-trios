# VariantGPT — Cloudflare + Fly.io deploy playbook

End-to-end stack:
```
Pages (variantgpt-web)         ← React SPA, static build
   │ HTTPS
Worker (variantgpt-api)         ← Hono /api/*
   ├── D1 (variantgpt)          ← cases, members, jobs, uploads, evidence, …
   └── R2 (variantgpt)          ← uploaded VCFs, generated case.json, reports
        │
Fly.io (variantgpt-engine)      ← Python engine (Starlette HTTP on :8080)
        │ ← Worker invokes POST /run with signed R2 URLs
        │ → Engine POSTs progress to Worker /api/internal/engine-callback/:id
```

Prereqs: a Cloudflare account, a Fly.io account, both CLIs installed and logged in.

```powershell
npm i -g wrangler            # already installed (4.85.0)
iwr https://fly.io/install.ps1 -useb | iex
wrangler login
fly auth login
```

---

## 1. Deploy the engine to Fly.io

```powershell
# From repo root (where fly.toml lives).
cd D:\Projects\VariantGPT
fly launch --no-deploy --copy-config --name variantgpt-engine --region iad
# Choose region: "iad" (Virginia, US-East), "bom" (Mumbai), "fra" (Frankfurt), etc.

# Mint a long-random shared bearer (the Worker also gets this same value).
$bearer = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | % { [char]$_ })
fly secrets set ENGINE_BEARER=$bearer

# Remote build (no local Docker needed) + deploy.
fly deploy --remote-only
```

After deploy, note the public URL (usually `https://variantgpt-engine.fly.dev`). Smoke test:

```powershell
curl https://variantgpt-engine.fly.dev/healthz       # {"ok": true}
```

**Save `$bearer` somewhere** — you'll paste it into the Worker secrets in step 4.

---

## 2. Create the D1 database

```powershell
cd D:\Projects\VariantGPT\app\api
wrangler d1 create variantgpt
```

Wrangler prints a UUID — paste it into `app/api/wrangler.toml` replacing `REPLACE_WITH_D1_ID`. Then apply migrations:

```powershell
wrangler d1 migrations apply variantgpt --remote
```

---

## 3. Create the R2 bucket + API token

```powershell
wrangler r2 bucket create variantgpt
```

Mint an R2 access token in the Cloudflare dashboard:
**R2 → Manage R2 API Tokens → Create API Token**
- Permissions: **Object Read & Write**
- Bucket: **variantgpt**

Copy the **Access Key ID** and **Secret Access Key**. Also note your **Cloudflare Account ID** (top-right of the dashboard, or `wrangler whoami`).

---

## 4. Set Worker secrets

```powershell
cd D:\Projects\VariantGPT\app\api

wrangler secret put R2_ACCESS_KEY_ID          # paste from step 3
wrangler secret put R2_SECRET_ACCESS_KEY      # paste from step 3
wrangler secret put R2_ACCOUNT_ID             # your CF account ID

wrangler secret put ENGINE_BEARER             # paste $bearer from step 1
wrangler secret put ENGINE_WEBHOOK_SECRET     # any 32+ char random string

# Optional, once LLM features land:
# wrangler secret put OPENROUTER_API_KEY
```

Also set the same `ENGINE_WEBHOOK_SECRET` on the Fly side so callback signatures match (we already passed it through the run payload, but if you ever rotate it on the Worker, both ends update):

```powershell
# Not strictly needed — the Worker passes the secret to the engine in each
# /run payload, so the engine doesn't need its own copy unless you want
# defense in depth. Skip for the first deploy.
```

---

## 5. Deploy the Worker

```powershell
cd D:\Projects\VariantGPT\app\api
npm install
wrangler deploy
```

Note the deployed URL (e.g. `https://variantgpt-api.<your-subdomain>.workers.dev`).

Update `app/api/wrangler.toml` so `PUBLIC_API_BASE` matches the URL wrangler just printed, plus `ENGINE_BASE_URL` from step 1. Then re-deploy so the vars take effect:

```powershell
wrangler deploy
```

---

## 6. Deploy the SPA to Pages

```powershell
cd D:\Projects\VariantGPT\app\web
$env:VITE_API_BASE = "https://variantgpt-api.<your-subdomain>.workers.dev"
npm install
npm run build
npx wrangler pages deploy dist --project-name=variantgpt-web
```

---

## 7. Smoke test

1. Open the Pages URL printed by step 6.
2. Click **New case**, drop in the three demo VCFs from `data/test/demo_trio/`:
   - `proband.vcf` → proband
   - `father.vcf` → father
   - `mother.vcf` → mother
3. Click **Run**. RunMonitor should progress queued → running → ready within ~10s after the engine warms up (first run after idle: +5s cold start on Fly).
4. Open the case in the workbench — confirm 11 variants, tier distribution `2 P · 2 LP · 4 VUS · 1 LB · 2 B`, and 1 MEFV reclassification proposal.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/cases/:id/upload-url/:role` → 403 / signing fails | R2 sigv4 keys wrong, or `R2_ACCOUNT_ID` doesn't match the R2 endpoint subdomain | Re-check the keys in step 3; `wrangler secret list` to confirm they exist |
| Upload PUT to R2 returns 403 | Browser is sending an extra header that isn't in the signed payload (e.g. credentials) | Check Network tab: signed URL should be in the request URL; only `content-type` header should be set |
| `/api/cases/:id/run` returns 400 "no uploaded VCF found" | Upload PUT succeeded but the `uploads` row wasn't recorded (signed URL was used twice, race) | Refresh the page and re-upload |
| Status stays `queued` forever | Worker → engine call failed silently | `fly logs -a variantgpt-engine` (Fly side) and `wrangler tail` (Worker side); look for `engine N: ...` messages in the jobs table |
| Status flips to `error: engine 401: ...` | `ENGINE_BEARER` mismatch | `fly secrets list` and `wrangler secret list`; both must hold the same string |
| Status: `error: container N` (or similar) | Engine ran but case.json PUT to R2 failed | Check the engine log for the URL it tried; signed PUT URLs expire after 1h |
| `case.json` not found on workbench | Engine never finished, or R2 key mismatch | Check `wrangler r2 object list variantgpt --prefix cases/<id>/` |
| Pages 404 on deep links (`/cases/abc`) | `_redirects` missing from the build output | Confirm `app/web/public/_redirects` exists; rebuild and re-deploy |
| CORS errors in the browser | Worker has `Access-Control-Allow-Origin: *` from Hono CORS but Pages domain mismatched | The SPA fetches absolute URLs (via `VITE_API_BASE`) — CORS is needed; check the `cors()` middleware in `app/api/src/index.ts` |

## Cost notes (rough, idle workloads)

- Cloudflare Workers free tier: 100k requests/day.
- D1 free tier: 5M reads / 100k writes / 5GB.
- R2: free for 10 GB stored + 1M class-A ops/mo (we don't have hot reads at scale).
- Fly.io: free 3 shared-cpu-1x machines + 3GB persistent volumes. With scale-to-zero, the engine costs essentially $0 when idle.
