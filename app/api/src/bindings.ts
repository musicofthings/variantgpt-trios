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
};

export type Variables = {
  userId: string;
};
