export type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  // R2 sigv4 credentials for presigning client-direct PUT/GET URLs.
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  // Public base URL of this Worker (used by the engine's status callbacks).
  PUBLIC_API_BASE: string;
  // Fly.io-hosted engine HTTP endpoint + shared bearer.
  ENGINE_BASE_URL: string;          // e.g. "https://variantgpt-engine.fly.dev"
  ENGINE_BEARER: string;            // secret; matches Fly's ENGINE_BEARER
  ENGINE_WEBHOOK_SECRET: string;    // HMAC key for status callbacks Fly → Worker
  AI_GATEWAY_ACCOUNT: string;
  AI_GATEWAY_ID: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL_NARRATIVE: string;
  OPENROUTER_MODEL_HPO: string;
  /** Direct Anthropic API key — preferred over OpenRouter for the AI
   *  synopsis path (single round-trip, no OpenRouter markup). Optional;
   *  when unset the synopsis endpoint returns 503. */
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL_SYNOPSIS?: string;  // default: claude-3-5-haiku-latest

  /** R2 key prefix where the GenomeAsia ingestion CLI uploaded the
   *  per-chrom AF TSVs (e.g. "tracks/genomeasia/v1"). When set, the
   *  /api/cases/:id/run handler mints a signed URL template the engine
   *  uses for AF lookups. When unset, the GenomeAsia adapter no-ops. */
  GENOMEASIA_R2_PREFIX?: string;

  /** Clerk JWT validation.
   *  - CLERK_ISSUER: e.g. "https://your-app.clerk.accounts.dev" (Clerk dashboard
   *                 → Configure → API keys → "Issuer URL"). When unset, auth
   *                 is disabled and the Worker accepts unauthenticated requests
   *                 (matches the SPA's dev-mode pass-through).
   *  - CLERK_AUDIENCE: optional. If set, must match `aud` in the JWT. Usually
   *                  the same as your Clerk instance URL.
   */
  CLERK_ISSUER?: string;
  CLERK_AUDIENCE?: string;

  /** Cloudflare native Rate Limiting binding (open beta), declared in
   *  wrangler.toml. Buckets /api/* requests per Clerk user (IP fallback).
   *  Optional: when absent the rate-limit middleware is a pass-through. */
  RATE_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };

  /** Optional Cloudflare Browser Rendering REST token (account API token with
   *  the Browser Rendering permission). When set (alongside R2_ACCOUNT_ID, which
   *  is the same Cloudflare account id), POST /api/cases/:id/report?format=pdf
   *  server-renders the report HTML to PDF. When unset, the endpoint still
   *  returns the self-contained HTML (?format=html, the default). */
  BROWSER_RENDERING_TOKEN?: string;
};

export type Variables = {
  userId: string;
};
