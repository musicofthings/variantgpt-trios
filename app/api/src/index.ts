import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Bindings, Variables } from "./bindings";
import { casesRouter } from "./routes/cases";
import { variantsRouter } from "./routes/variants";
import { proposalsRouter } from "./routes/proposals";
import { apiRouter } from "./routes/api";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use("*", logger());
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "DELETE"], credentials: false }));

app.get("/", (c) => c.json({ name: "variantgpt-api", version: "0.1.0" }));
app.get("/health", (c) => c.json({ ok: true }));

// /api/* — surface the SPA expects (matches the Vite dev middleware contract).
app.route("/api", apiRouter);

// /cases, /variants, /proposals — richer RESTful surface for future curator UI.
app.route("/cases", casesRouter);
app.route("/variants", variantsRouter);
app.route("/proposals", proposalsRouter);

export default app;
