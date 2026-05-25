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

Prereqs: Cloudflare account, Fly.io account, GitHub repo (already wired). Local installs needed: only `wrangler` and `gh` (no local flyctl, no local Docker).

```powershell
npm i -g wrangler             # already installed (4.85.0)
wrangler login                # already done
gh auth login                 # already done
```

---

## 1. Deploy the engine via GitHub Actions (no local flyctl)

We don't install flyctl locally; CI does it. You just need to add three GitHub repo secrets and push — `.github/workflows/deploy.yml` handles the rest.

**1a. Sign up for Fly.io (web):** https://fly.io/app/sign-up

**1b. Mint a Fly API token:** https://fly.io/user/personal_access_tokens → **Create access token** → copy the value (starts with `fo1_…`).

**1c. Generate a long-random ENGINE_BEARER** in PowerShell:
```powershell
$bearer = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | % { [char]$_ })
$bearer    # copy this; you'll paste it twice
```

**1d. Add the secrets to the GitHub repo:**
```powershell
cd D:\Projects\VariantGPT
gh secret set FLY_API_TOKEN -R musicofthings/variantgpt-trios          # paste fo1_…
gh secret set ENGINE_BEARER -R musicofthings/variantgpt-trios          # paste $bearer
gh secret set CLOUDFLARE_API_TOKEN -R musicofthings/variantgpt-trios   # see step 3
gh secret set CLOUDFLARE_ACCOUNT_ID -R musicofthings/variantgpt-trios  # 3b54d713791d243cfbed61dfeb46e1fc
```

**1e. Push to main → CI deploys.** The `engine` job runs `flyctl deploy --remote-only` which builds the image in Fly's cloud and provisions the app on first run.

Watch the run:
```powershell
gh run watch -R musicofthings/variantgpt-trios
```

After it succeeds, the engine is live at `https://variantgpt-engine.fly.dev`. Smoke test:
```powershell
curl https://variantgpt-engine.fly.dev/healthz       # {"ok": true}
```

---

## 2. D1 database (already provisioned)

`variantgpt-db` (`08b9511b-69c6-49e1-ae83-36a16fe90a28`) is wired in `app/api/wrangler.toml` and migrations 0001 + 0002 are already applied to it.

To re-apply after schema changes:
```powershell
cd D:\Projects\VariantGPT\app\api
wrangler d1 migrations apply variantgpt-db --remote
```

---

## 3. R2 bucket (already provisioned) + API token

The `variantgpt` bucket exists. Mint an R2 token for sigv4 presigning:

**Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API Token**
- Permissions: **Object Read & Write**
- Specify bucket: **variantgpt**

Copy the **Access Key ID** and **Secret Access Key**.

You also need a **Cloudflare API Token** for CI deploys (separate from the R2 token):

**Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token**
- Permissions: Account: **Workers Scripts** Edit + **Cloudflare Pages** Edit + **D1** Edit + **Workers R2 Storage** Edit + **Account Settings** Read
- Account Resources: include your account
- Copy the token value.

Add the API token to GitHub secrets (you already did this in step 1d if you followed the flow above).

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
