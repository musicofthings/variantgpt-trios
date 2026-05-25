# infra

Cloudflare infrastructure: D1 migrations, wrangler config, AI Gateway notes.

## D1
```
# Create database
npx wrangler d1 create variantgpt
# Copy database_id into app/api/wrangler.toml

# Apply migrations
npx wrangler d1 migrations apply variantgpt --local      # local dev
npx wrangler d1 migrations apply variantgpt --remote     # production
```

## R2
```
npx wrangler r2 bucket create variantgpt
```

Buckets store: per-case VCFs (`cases/{caseId}/vcf/*.vcf.gz`), tabix population
tracks (`tracks/indigenomes-v1/...`), generated reports
(`cases/{caseId}/reports/*.pdf`).

## AI Gateway
Per PRD §6.7: create a gateway named `variantgpt`, route to OpenRouter, **pin
the model** in `wrangler.toml` env vars, log every call (model, resolved
provider, params, prompt hash, token counts).
