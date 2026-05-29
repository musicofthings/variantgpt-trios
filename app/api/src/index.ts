import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Bindings, Variables } from "./bindings";
import { clerkAuthGated } from "./auth";
import { casesRouter } from "./routes/cases";
import { variantsRouter } from "./routes/variants";
import { proposalsRouter } from "./routes/proposals";
import { apiRouter } from "./routes/api";
import { aiRouter } from "./routes/ai";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", logger());
// CORS allows the Authorization header for Clerk-bearing requests; expose
// 401 / 403 so the SPA can detect token expiry and call getToken() again.
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "authorization"],
  credentials: false,
}));
// Auth gate — verifies Clerk JWT against JWKS. Internal webhook paths and
// /health are bypassed by isPublicPath() inside clerkAuthGated. When
// CLERK_ISSUER is unset, the middleware is a pass-through (dev mode).
app.use("*", clerkAuthGated);

app.get("/", (c) => c.json({ name: "variantgpt-api", version: "0.1.0" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/* — surface the SPA expects (matches the Vite dev middleware contract).
app.route("/api", apiRouter);
// /api/ai/* — AI-drafted synopsis & narrative endpoints. Mounted as a
// sibling under /api so it shares the Clerk auth gate.
app.route("/api/ai", aiRouter);

// /cases, /variants, /proposals — richer RESTful surface for future curator UI.
app.route("/cases", casesRouter);
app.route("/variants", variantsRouter);
app.route("/proposals", proposalsRouter);

export default app;
