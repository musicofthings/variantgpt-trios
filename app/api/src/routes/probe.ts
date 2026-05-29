/** TEMPORARY probe route — fetches an arbitrary upstream URL HEAD from the
 *  Cloudflare Worker edge so we can sanity-check whether a third-party
 *  host (currently: browser.genomeasia100k.org) is reachable from Cloudflare's
 *  network when our build/Fly egress IPs are blocked.
 *
 *  Auth: gated by the standard Clerk middleware. Only signed-in operators
 *  hit this.
 *
 *  Remove this file (and its mount in src/index.ts) once the GenomeAsia
 *  ingestion path is finalized.
 */
import { Hono } from "hono";
import type { Bindings, Variables } from "../bindings";

export const probeRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

probeRouter.get("/head", async (c) => {
  const target = c.req.query("url");
  if (!target) return c.json({ error: "missing url" }, 400);
  let parsed: URL;
  try { parsed = new URL(target); }
  catch { return c.json({ error: "invalid url" }, 400); }
  // Only allow HTTPS to avoid being an open proxy.
  if (parsed.protocol !== "https:") return c.json({ error: "https only" }, 400);

  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch(target, { method: "HEAD", redirect: "follow" });
  } catch (e) {
    return c.json({
      ok: false,
      elapsedMs: Date.now() - start,
      error: String(e).slice(0, 400),
    }, 502);
  }

  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });

  return c.json({
    ok: resp.ok,
    elapsedMs: Date.now() - start,
    status: resp.status,
    statusText: resp.statusText,
    finalUrl: resp.url,
    headers,
  });
});
