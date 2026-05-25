/**
 * /api/* — the surface the SPA expects, matching app/web/vite.devCaseApi.ts.
 *
 * Cloudflare deploy notes (PRD §6.6):
 *   - VCFs are NOT uploaded through the Worker. The client GETs a signed R2
 *     PUT URL from /api/cases/:id/upload-url/:role and streams bytes direct.
 *   - The engine doesn't run on the Worker — it runs in the EngineContainer
 *     bound at env.ENGINE. We POST a job spec to the container with signed
 *     R2 GET/PUT URLs; it does the data motion and POSTs status back here.
 *   - All durable state (jobs, uploads, results pointer) lives in D1; case.json
 *     artifacts live in R2.
 */
import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import type { Bindings, Variables } from "../bindings";

export const apiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ───────────────────────── helpers ─────────────────────────

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ALLOWED_ROLES = new Set(["proband", "father", "mother", "sibling", "relative"]);
const ALLOWED_EXTS = new Set(["vcf", "vcf.gz", "bam"]);

function sanitize(id: string): string | null {
  return SAFE_ID.test(id) ? id : null;
}

function r2Endpoint(accountId: string) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function r2Client(env: Bindings) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

/** Presigned R2 URL via S3-compat sigv4. Valid for `expiresSec` seconds. */
async function signR2(
  env: Bindings, bucket: string, key: string, method: "GET" | "PUT", expiresSec = 3600,
): Promise<string> {
  const aws = r2Client(env);
  const url = `${r2Endpoint(env.R2_ACCOUNT_ID)}/${bucket}/${encodeURI(key)}?X-Amz-Expires=${expiresSec}`;
  const signed = await aws.sign(
    new Request(url, { method }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

function pickExt(filename: string | undefined): string | null {
  if (!filename) return "vcf";
  const lower = filename.toLowerCase();
  if (lower.endsWith(".vcf.gz")) return "vcf.gz";
  if (lower.endsWith(".vcf")) return "vcf";
  if (lower.endsWith(".bam")) return "bam";
  return null;
}

// ───────────────────────── routes ─────────────────────────

/**
 * GET /api/hpo/search?q=<text>&limit=<n>
 * → { results: [{ id: "HP:0001250", label: "Seizure", definition?, synonyms? }] }
 *
 * Proxies the EBI OLS4 ontology search so the SPA never talks to a
 * third-party domain. Results cached at the Worker edge for 1h — HPO
 * doesn't change often and popular queries are highly repeat.
 *
 * Accepts either label text ("seiz") or a partial HP id ("HP:00012").
 */
apiRouter.get("/hpo/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10", 10) || 10, 25);
  if (q.length < 2) return c.json({ results: [] });

  // Cache key is the full request URL — Cloudflare cache picks this up via
  // the standard Cache API. 1h TTL is the right tradeoff for an ontology.
  const cacheKey = new Request(
    `https://hpo-cache.variantgpt/${encodeURIComponent(q)}/${limit}`,
    { method: "GET" },
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // OLS supports two query modes — the user might type "HP:0001250" or
  // "seizure". The /search endpoint covers both (id match by exact, label
  // by fuzzy/prefix).
  const olsUrl = new URL("https://www.ebi.ac.uk/ols4/api/search");
  olsUrl.searchParams.set("q", q);
  olsUrl.searchParams.set("ontology", "hp");
  olsUrl.searchParams.set("rows", String(limit));
  olsUrl.searchParams.set("fieldList", "obo_id,label,description,synonym,iri");
  olsUrl.searchParams.set("queryFields", "obo_id,label,synonym");

  let upstream: Response;
  try {
    upstream = await fetch(olsUrl.toString(), {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (e) {
    return c.json({ results: [], error: `ols unreachable: ${String(e).slice(0, 100)}` }, 502);
  }
  if (!upstream.ok) {
    return c.json({ results: [], error: `ols ${upstream.status}` }, 502);
  }

  const data: {
    response?: {
      docs?: Array<{
        obo_id?: string;
        label?: string;
        description?: string[];
        synonym?: string[];
        iri?: string;
      }>;
    };
  } = await upstream.json();

  const results = (data.response?.docs ?? [])
    .filter((d) => d.obo_id?.startsWith("HP:"))
    .map((d) => ({
      id: d.obo_id!,
      label: d.label ?? "",
      definition: d.description?.[0],
      synonyms: d.synonym?.slice(0, 3),
    }));

  const res = c.json({ results });
  // Clone the response into the edge cache. Must set s-maxage for Cache API.
  res.headers.set("cache-control", "public, s-maxage=3600");
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

/**
 * GET /api/cases/:id/upload-url/:role?filename=foo.vcf.gz
 * → { url, key, expiresIn }
 *
 * Client uses the returned URL with a single PUT to stream the file body
 * directly to R2 — bytes never touch the Worker.
 */
apiRouter.get("/cases/:id/upload-url/:role", async (c) => {
  const id = sanitize(c.req.param("id"));
  const role = c.req.param("role");
  const filename = c.req.query("filename");
  if (!id) return c.json({ error: "bad caseId" }, 400);
  if (!ALLOWED_ROLES.has(role)) return c.json({ error: "bad role" }, 400);
  const ext = pickExt(filename ?? undefined);
  if (!ext || !ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "unsupported file extension (allowed: vcf, vcf.gz, bam)" }, 400);
  }

  const key = `cases/${id}/uploads/${role}.${ext}`;
  const url = await signR2(c.env, "variantgpt", key, "PUT", 3600);

  // The case row MUST exist before the uploads row — uploads.case_id has a
  // FOREIGN KEY into cases(id). Order matters; don't reorder these.
  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft')
     ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Case ${id}`).run();
  await c.env.DB.prepare(
    `INSERT INTO uploads (case_id, role, r2_key, filename, uploaded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(case_id, role) DO UPDATE SET
       r2_key=excluded.r2_key, filename=excluded.filename, uploaded_at=excluded.uploaded_at`,
  ).bind(id, role, key, filename ?? null, Date.now()).run();

  return c.json({ url, key, expiresIn: 3600, role, filename: filename ?? null });
});

/**
 * POST /api/cases/:id/run     body = manifest JSON (same shape as dev API)
 * → 202 { ok, caseId, status }
 *
 * Side effects: insert/update jobs row, mint signed R2 GET URLs for each
 * uploaded VCF + a PUT URL for the case.json, then invoke the container.
 */
apiRouter.post("/cases/:id/run", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const manifest = await c.req.json<{
    pedigree: { id: string; role: string; sex: string; affected: boolean; missing?: boolean; sample_name?: string }[];
    consanguineous?: boolean;
    hpo?: string[];
    history?: string;
    files: Record<string, string>;
  }>();

  // Confirm uploads exist before kicking off — keeps the engine from running on
  // a half-populated case.
  const uploads = await c.env.DB.prepare(
    `SELECT role, r2_key FROM uploads WHERE case_id = ?`,
  ).bind(id).all<{ role: string; r2_key: string }>();
  const byRole = new Map((uploads.results ?? []).map((r) => [r.role, r.r2_key]));
  for (const role of Object.keys(manifest.files)) {
    if (!byRole.has(role)) {
      return c.json({ error: `no uploaded VCF found for role=${role}` }, 400);
    }
  }

  // Mint signed URLs for the container.
  const vcfUrls: Record<string, string> = {};
  for (const [role, key] of byRole.entries()) {
    vcfUrls[role] = await signR2(c.env, "variantgpt", key, "GET", 3600);
  }
  const caseJsonKey = `cases/${id}/case.json`;
  const casePutUrl = await signR2(c.env, "variantgpt", caseJsonKey, "PUT", 3600);

  // Persist job row in queued state.
  await c.env.DB.prepare(
    `INSERT INTO jobs (case_id, status, started_at, log_json, manifest_json)
     VALUES (?, 'queued', ?, '[]', ?)
     ON CONFLICT(case_id) DO UPDATE SET
       status='queued', started_at=excluded.started_at, finished_at=NULL,
       error=NULL, log_json='[]', manifest_json=excluded.manifest_json`,
  ).bind(id, Date.now(), JSON.stringify(manifest)).run();

  // Invoke the Fly-hosted engine. The engine returns 202 quickly, then runs
  // the job in a background task; it posts progress to the callback URL.
  const callbackUrl = `${c.env.PUBLIC_API_BASE}/api/internal/engine-callback/${id}`;
  const engineUrl = `${c.env.ENGINE_BASE_URL.replace(/\/$/, "")}/run`;
  const engineReq = fetch(engineUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${c.env.ENGINE_BEARER}`,
    },
    body: JSON.stringify({
      case_id: id,
      manifest,
      vcf_urls: vcfUrls,
      case_put_url: casePutUrl,
      callback_url: callbackUrl,
      callback_secret: c.env.ENGINE_WEBHOOK_SECRET,
    }),
  });
  c.executionCtx.waitUntil(
    engineReq.then(async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        await c.env.DB.prepare(
          `UPDATE jobs SET status='error', error=?, finished_at=? WHERE case_id=?`,
        ).bind(`engine ${r.status}: ${text.slice(0, 200)}`, Date.now(), id).run();
      }
    }).catch(async (e) => {
      await c.env.DB.prepare(
        `UPDATE jobs SET status='error', error=?, finished_at=? WHERE case_id=?`,
      ).bind(`engine invoke failed: ${String(e).slice(0, 200)}`, Date.now(), id).run();
    }),
  );

  return c.json({ ok: true, caseId: id, status: "queued" }, 202);
});

/**
 * GET /api/cases/:id/status
 * → matches the dev middleware's JobStatus shape used by useJobStatus().
 */
apiRouter.get("/cases/:id/status", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT status, started_at, finished_at, error, log_json, manifest_json
     FROM jobs WHERE case_id = ?`,
  ).bind(id).first<{
    status: string;
    started_at: number | null;
    finished_at: number | null;
    error: string | null;
    log_json: string;
    manifest_json: string | null;
  }>();
  if (!row) return c.json({ status: "unknown" });

  let manifest: { fileCount?: number; memberCount?: number; missingCount?: number } | undefined;
  try {
    if (row.manifest_json) {
      const m = JSON.parse(row.manifest_json) as {
        pedigree?: { missing?: boolean }[];
        files?: Record<string, string>;
      };
      manifest = {
        memberCount: m.pedigree?.length,
        missingCount: m.pedigree?.filter((p) => p.missing).length,
        fileCount: Object.keys(m.files ?? {}).length,
      };
    }
  } catch { /* malformed manifest, surface nothing */ }

  const now = Date.now();
  return c.json({
    status: row.status,
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    elapsedMs: row.started_at ? (row.finished_at ?? now) - row.started_at : 0,
    manifest,
    log: JSON.parse(row.log_json || "[]").slice(-15),
  });
});

/**
 * POST /api/internal/engine-callback/:id
 *   body = { status, log, error?, finishedAt? }
 *   header X-VGPT-Signature = HMAC-SHA256(ENGINE_WEBHOOK_SECRET, body)
 *
 * The container POSTs progress here. Authenticated by HMAC since the container
 * is the only thing that knows the shared secret.
 */
apiRouter.post("/internal/engine-callback/:id", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);

  const bodyText = await c.req.text();
  const sig = c.req.header("x-vgpt-signature") ?? "";
  const expected = await hmacSha256Hex(c.env.ENGINE_WEBHOOK_SECRET, bodyText);
  if (!timingSafeEq(sig, expected)) {
    return c.json({ error: "bad signature" }, 401);
  }

  const payload = JSON.parse(bodyText) as {
    status: "running" | "ready" | "error";
    log?: string[];
    error?: string;
    finishedAt?: number;
  };
  await c.env.DB.prepare(
    `UPDATE jobs SET
       status = ?,
       error = COALESCE(?, error),
       finished_at = COALESCE(?, finished_at),
       log_json = ?
     WHERE case_id = ?`,
  ).bind(
    payload.status,
    payload.error ?? null,
    payload.finishedAt ?? null,
    JSON.stringify((payload.log ?? []).slice(-50)),
    id,
  ).run();

  return c.json({ ok: true });
});

/**
 * GET /api/cases/:id
 * → streams case.json from R2 (engine output).
 */
apiRouter.get("/cases/:id", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const obj = await c.env.BUCKET.get(`cases/${id}/case.json`);
  if (!obj) return c.json({ error: "case.json not found" }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

/**
 * GET /api/cases
 * → list cases visible to this account (active + history).
 */
apiRouter.get("/cases", async (c) => {
  // Join jobs + uploads + cases. Keep it simple — caller paginates client-side.
  const rows = await c.env.DB.prepare(
    `SELECT
       c.id AS caseId,
       COALESCE(j.status, 'unknown') AS status,
       j.started_at AS startedAt,
       j.finished_at AS finishedAt,
       j.error AS error,
       (SELECT COUNT(*) FROM uploads u WHERE u.case_id = c.id) AS fileCount,
       j.manifest_json AS manifest_json
     FROM cases c
     LEFT JOIN jobs j ON j.case_id = c.id
     ORDER BY COALESCE(j.started_at, 0) DESC
     LIMIT 200`,
  ).all<{
    caseId: string;
    status: string;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    fileCount: number;
    manifest_json: string | null;
  }>();

  const cases = (rows.results ?? []).map((r) => {
    let memberCount: number | undefined;
    let missingCount: number | undefined;
    try {
      if (r.manifest_json) {
        const m = JSON.parse(r.manifest_json) as { pedigree?: { missing?: boolean }[] };
        memberCount = m.pedigree?.length;
        missingCount = m.pedigree?.filter((p) => p.missing).length;
      }
    } catch { /* tolerate malformed JSON */ }
    return {
      caseId: r.caseId,
      status: r.status,
      startedAt: r.startedAt ?? undefined,
      finishedAt: r.finishedAt ?? undefined,
      error: r.error ?? undefined,
      fileCount: r.fileCount,
      memberCount,
      missingCount,
      hasResult: r.status === "ready",
    };
  });
  return c.json({ cases });
});

// ───────────────────────── crypto helpers ─────────────────────────

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
