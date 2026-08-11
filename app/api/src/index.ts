import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Bindings, Variables } from "./bindings";
import { clerkAuthGated } from "./auth";
import { rateLimitGated } from "./ratelimit";
import { apiRouter } from "./routes/api";
import { aiRouter } from "./routes/ai";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", logger());
// CORS. The SPA is the only browser client; allowed origins come from the
// ALLOWED_ORIGINS env var (comma-separated). When it's unset (local dev) we
// reflect the request origin so `wrangler dev` + Vite just work. Auth is
// bearer-token (credentials:false), so we never emit a wildcard alongside
// credentials. Origins are matched per-request, so build the middleware inside
// a wrapper that can read c.env.
app.use("*", async (c, next) => {
  const allowlist = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    origin: (origin) => {
      if (allowlist.length === 0) return origin || "*"; // dev: no allowlist configured
      return allowlist.includes(origin) ? origin : null; // prod: reflect only allowed origins
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    credentials: false,
  })(c, next);
});
// Auth gate — verifies Clerk JWT against JWKS. Internal webhook paths and
// /health are bypassed by isPublicPath() inside clerkAuthGated. When
// CLERK_ISSUER is unset, the middleware is a pass-through (dev mode).
app.use("*", clerkAuthGated);
// Per-user rate limiting — runs AFTER auth so it can bucket by Clerk user id
// (falls back to client IP). Internal/health paths are exempt; no-ops when the
// RATE_LIMITER binding is absent (dev/preview).
app.use("*", rateLimitGated);

app.get("/", (c) => c.json({ name: "variantgpt-api", version: "0.1.0" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/* — the ONE canonical surface. It's what the SPA calls (see
// app/web/src/apiBase.ts, which prefixes every path with /api) and the only
// surface with tenant-ownership enforcement (caseAccessGate in routes/api.ts).
app.route("/api", apiRouter);
// /api/ai/* — AI-drafted synopsis & narrative endpoints. Mounted as a
// sibling under /api so it shares the Clerk auth gate.
app.route("/api/ai", aiRouter);

// NOTE: the earlier /cases and /variants routers (routes/cases.ts,
// variants.ts) are intentionally NOT mounted. They were an unreachable second
// case API — the SPA never called them, they query D1 tables the pipeline
// doesn't populate, and they lacked ownership checks. They MUST gain owner
// scoping (like caseAccessGate) before being re-mounted. Do not re-add them
// here as-is.
//
// routes/proposals.ts is gone: the curator reclass-decision flow it sketched
// now lives for real at /api/cases/:id/decisions in routes/api.ts (owner-scoped
// via caseAccessGate, keyed to case.json rather than the empty D1 variants
// table). See src/decisions.ts for the rules.

export default app;
