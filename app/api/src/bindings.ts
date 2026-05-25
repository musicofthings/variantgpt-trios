import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ENGINE: DurableObjectNamespace;       // EngineContainer (engine/Dockerfile)
  // R2 sigv4 credentials for presigning client-direct PUT/GET URLs.
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  // Public base URL of this Worker (used by the container's status callbacks).
  PUBLIC_API_BASE: string;
  ENGINE_WEBHOOK_SECRET: string;
  AI_GATEWAY_ACCOUNT: string;
  AI_GATEWAY_ID: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL_NARRATIVE: string;
  OPENROUTER_MODEL_HPO: string;
};

export type Variables = {
  userId: string;
};
