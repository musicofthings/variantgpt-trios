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

/** Mint a signed-URL TEMPLATE for the GenomeAsia AF tracks, with a
 *  literal `{chrom}` placeholder the engine replaces per query. We sign
 *  a representative key first and then swap the chrom in the path. Works
 *  because sigv4 signQuery puts the signature in query params, not the
 *  path, so replacing the filename doesn't invalidate the signature
 *  prefix — but it DOES invalidate the URL itself. To handle this, we
 *  sign one URL per chrom up-front in a single Promise.all and emit them
 *  as a map. Cleaner than fighting sigv4. */
async function maybeGenomeAsiaTemplate(env: Bindings): Promise<string | null> {
  const prefix = env.GENOMEASIA_R2_PREFIX;
  if (!prefix) return null;
  // We don't try to template a single URL — instead the engine adapter
  // accepts a JSON map. Build it here.
  const buckets = [
    ...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`),
    "indels",
  ];
  const entries: Array<[string, string]> = await Promise.all(
    buckets.map(async (b) => [
      b,
      await signR2(env, "variantgpt", `${prefix}/af/${b}.tsv.gz`, "GET", 6 * 3600),
    ] as [string, string]),
  );
  // Engine adapter expects a "{chrom}" placeholder; encode the map as
  // a magic URL-like string with embedded JSON. The adapter's
  // template.replace("{chrom}", b) path needs the actual per-chrom URL,
  // so we encode the map as `data:application/json;base64,...` and the
  // adapter checks for that prefix. Simpler: just send the map directly
  // as `genomeasia_af_urls` (dict) instead of a template — adjust
  // the adapter accordingly.
  //
  // For minimum surgery, encode as a JSON object the adapter recognizes:
  // when the "template" starts with "json:", the suffix is a base64 JSON
  // object {chrom: url}. The adapter then looks up by chrom.
  const map = Object.fromEntries(entries);
  return "json:" + btoa(JSON.stringify(map));
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
  // The version segment is bumped whenever the upstream-call or response
  // shape changes — old responses cached at the edge are immediately stale.
  const cacheKey = new Request(
    `https://hpo-cache.variantgpt/v2/${encodeURIComponent(q)}/${limit}`,
    { method: "GET" },
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // /api/select is OLS's autocomplete endpoint — does prefix matching on
  // label + synonym fields, which /search does not. "microceph" matches
  // "Microcephaly" via /select; via /search it returns 0 results.
  const olsUrl = new URL("https://www.ebi.ac.uk/ols4/api/select");
  olsUrl.searchParams.set("q", q);
  olsUrl.searchParams.set("ontology", "hp");
  olsUrl.searchParams.set("rows", String(limit));
  olsUrl.searchParams.set("fieldList", "obo_id,label,description,synonym,iri");

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

/** Shape of the manifest the SPA sends and we persist in jobs.manifest_json. */
interface CaseManifest {
  pedigree: { id: string; role: string; sex: string; affected: boolean; missing?: boolean; sample_name?: string }[];
  consanguineous?: boolean;
  hpo?: string[];
  history?: string;
  files: Record<string, string>;
}

/** Shared engine-kickoff path used by both /run (first time) and /rerun
 * (after a failed/completed run). Returns the same 202 shape. */
async function kickEngineRun(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
  id: string,
  manifest: CaseManifest,
) {
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
  return _continueRun(c, id, manifest, byRole);
}

async function _continueRun(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
  id: string,
  manifest: CaseManifest,
  byRole: Map<string, string>,
) {

  // Mint signed URLs for the container.
  const vcfUrls: Record<string, string> = {};
  for (const [role, key] of byRole.entries()) {
    vcfUrls[role] = await signR2(c.env, "variantgpt", key, "GET", 3600);
  }
  const caseJsonKey = `cases/${id}/case.json`;
  const casePutUrl = await signR2(c.env, "variantgpt", caseJsonKey, "PUT", 3600);

  // Pipeline-stage checkpoints. The engine GET-probes each cache_urls.<stage>.get
  // at the start of the corresponding stage; if it's a cache hit, the stage
  // is skipped. On stage completion the engine PUTs the result to .put.
  // This makes reruns after a downstream failure cheap (the slow stages —
  // AF lookup and VEP REST — don't re-execute).
  // Versioned cache keys. Bump the version suffix when the Variant or
  // Joint schema changes in a way that makes older cached payloads
  // miss fields (e.g. adding calls/exon/genomic_hgvs in commit db1793a
  // bumped variants → v2).
  async function signCacheStage(stage: string) {
    const key = `cases/${id}/cache/${stage}.json.gz`;
    return {
      get: await signR2(c.env, "variantgpt", key, "GET", 3600),
      put: await signR2(c.env, "variantgpt", key, "PUT", 3600),
    };
  }
  const cacheUrls = {
    af_map: await signCacheStage("af_map"),
    // csq_v2: VEP REST now returns hgvs/exon/MANE_SELECT fields (added flags
    //         hgvs=1, numbers=1, mane=1). Force rebuild so cached CSQ
    //         entries pick up the new fields.
    csq: await signCacheStage("csq_v2"),
    // variants_v4: removed per-variant synchronous gnomAD lookup from
    //              annotate() (it was the real bottleneck — 60s/chunk —
    //              and the data is redundant with the myvariant.info
    //              ClinVar/dbNSFP batched fetch that runs right after).
    // variants_v7: expanded PredictorScores schema (added sift / polyphen2 /
    //              mutation_taster / lrt / fathmm / provean / metasvm /
    //              metalr / vest4) and case-level gene_info. Bump invalidates
    //              v6 caches so dbNSFP gets re-projected with the new fields.
    variants: await signCacheStage("variants_v7"),
  };

  // (No reference tracks signed currently. IndiGenomes lookup pivoted to
  // a live IGIB data.php API client in the engine since the bulk VCF has
  // no AF data. Re-add when GenomeAsia bulk freq integration lands.)

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
      cache_urls: cacheUrls,
      callback_url: callbackUrl,
      callback_secret: c.env.ENGINE_WEBHOOK_SECRET,
      // Proxy endpoint for IndiGen so the engine doesn't hit IGIB directly
      // (Fly IPs are blocked by IGIB; CF Worker IPs aren't). The engine
      // authenticates with the same ENGINE_BEARER it received in its
      // own Authorization header from us.
      indigen_proxy_url: `${c.env.PUBLIC_API_BASE}/api/internal/indigen-proxy`,
      indigen_proxy_bearer: c.env.ENGINE_BEARER,
      // GenomeAsia AF tracks — present only when GENOMEASIA_R2_PREFIX is
      // configured on the Worker (and the ingestion CLI has populated R2).
      // The engine adapter is a no-op when this is undefined.
      genomeasia_af_url_template: await maybeGenomeAsiaTemplate(c.env),
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
}

/**
 * POST /api/cases/:id/run     body = manifest JSON
 * → 202 { ok, caseId, status }
 *
 * First-time run. Validates uploads exist for every role in manifest.files,
 * persists the manifest in jobs.manifest_json, kicks off the engine.
 */
apiRouter.post("/cases/:id/run", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const manifest = await c.req.json<CaseManifest>();
  return kickEngineRun(c, id, manifest);
});

/**
 * POST /api/cases/:id/rerun
 * → 202 { ok, caseId, status }
 *
 * Re-trigger using the last submitted manifest (stored in jobs.manifest_json
 * from the previous /run). No body needed; uses the existing R2 uploads.
 * Lets the user iterate on the engine without re-uploading multi-GB VCFs
 * every time a run fails or they want to try with new engine logic.
 */
apiRouter.post("/cases/:id/rerun", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT manifest_json FROM jobs WHERE case_id = ?`,
  ).bind(id).first<{ manifest_json: string | null }>();
  if (!row?.manifest_json) {
    return c.json({ error: "no prior manifest — POST to /run first with full payload" }, 404);
  }
  let manifest: CaseManifest;
  try {
    manifest = JSON.parse(row.manifest_json) as CaseManifest;
  } catch {
    return c.json({ error: "stored manifest is malformed" }, 500);
  }
  return kickEngineRun(c, id, manifest);
});

/**
 * GET /api/cases/:id/manifest
 * → the persisted manifest (pedigree + HPO + file list). Used by Workbench
 *   to show what's on file and gate the Re-run button.
 */
apiRouter.get("/cases/:id/manifest", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT manifest_json FROM jobs WHERE case_id = ?`,
  ).bind(id).first<{ manifest_json: string | null }>();
  if (!row?.manifest_json) return c.json({ error: "not found" }, 404);
  try {
    return c.json(JSON.parse(row.manifest_json));
  } catch {
    return c.json({ error: "malformed manifest" }, 500);
  }
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
/**
 * POST /api/internal/indigen-proxy
 *   body = { gene: "<gene_name>" }
 *   header Authorization: Bearer <ENGINE_BEARER>
 *
 * Proxies a query to IGIB IndiGen's data.php for the engine. IGIB blocks
 * Fly's IP range (every direct request from the engine ConnectTimeouts),
 * but Cloudflare's edge IPs are routinely allowed by academic servers.
 * The engine calls this endpoint instead of clingen.igib.res.in directly.
 *
 * Returns the raw mydata array verbatim so the engine's existing parser
 * works without changes.
 */
apiRouter.post("/internal/indigen-proxy", async (c) => {
  // Auth: only the engine should call this, with the same bearer it
  // authenticates Fly→engine with.
  const auth = c.req.header("authorization") ?? "";
  const expected = `Bearer ${c.env.ENGINE_BEARER}`;
  if (auth !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { gene } = await c.req.json<{ gene?: string }>();
  if (!gene || typeof gene !== "string" || gene.length > 100) {
    return c.json({ error: "bad gene" }, 400);
  }

  // Edge cache the response — gene queries are idempotent and IndiGen v1
  // dates to 2020 (data doesn't change). 7-day cache covers most cases.
  const cacheKey = new Request(
    `https://indigen-cache.variantgpt/${encodeURIComponent(gene)}`,
    { method: "GET" },
  );
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await fetch("https://clingen.igib.res.in/indigen/data.php", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; variantgpt-proxy/0.1)",
      },
      body: JSON.stringify({ Name: gene }),
      cf: { cacheTtl: 7 * 24 * 3600, cacheEverything: true },
    });
  } catch (e) {
    return c.json({ error: `igib unreachable: ${String(e).slice(0, 120)}` }, 502);
  }
  if (!upstream.ok) {
    return c.json({ error: `igib ${upstream.status}` }, 502);
  }
  // Pass through the JSON. Set our cache-control so caches.default keeps it.
  const body = await upstream.text();
  const res = new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=604800",
    },
  });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
});

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
      orphan: false,
    };
  });

  // Also surface R2-only orphans: cases whose VCFs are still in R2 but whose
  // D1 row was deleted (e.g. a Delete that didn't purge R2, or a manual D1
  // wipe). These are recoverable — the user can either delete the R2 objects
  // or rebuild the case row from them.
  const knownIds = new Set(cases.map((c) => c.caseId));
  try {
    let cursor: string | undefined;
    const orphanFiles: Record<string, string[]> = {};
    do {
      const page = await c.env.BUCKET.list({ prefix: "cases/", cursor, limit: 1000, delimiter: "/" });
      // R2 list with delimiter returns common prefixes (each case dir) in `delimitedPrefixes`.
      for (const prefix of page.delimitedPrefixes ?? []) {
        const id = prefix.replace(/^cases\//, "").replace(/\/$/, "");
        if (!id || knownIds.has(id)) continue;
        orphanFiles[id] = [];
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    // For each orphan directory, list the actual objects to count files.
    for (const id of Object.keys(orphanFiles)) {
      const inner = await c.env.BUCKET.list({ prefix: `cases/${id}/uploads/`, limit: 20 });
      orphanFiles[id] = inner.objects.map((o) => o.key);
    }

    for (const [id, keys] of Object.entries(orphanFiles)) {
      const hasResult = (await c.env.BUCKET.head(`cases/${id}/case.json`).catch(() => null)) !== null;
      cases.push({
        caseId: id,
        status: hasResult ? "ready" : "unknown",
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        fileCount: keys.length,
        memberCount: undefined,
        missingCount: undefined,
        hasResult,
        orphan: true,
      });
    }
  } catch (e) {
    // R2 scan is best-effort; never let it block the cases endpoint.
    console.error("orphan scan failed:", e);
  }

  return c.json({ cases });
});

/** Delete every R2 object under `cases/<id>/`. Returns the count. */
async function purgeCaseR2(env: Bindings, id: string): Promise<number> {
  let purged = 0;
  let cursor: string | undefined;
  // R2 list pages at 1000; iterate to be safe even though typical cases
  // have ≤4 objects (3 uploads + case.json).
  do {
    const page = await env.BUCKET.list({ prefix: `cases/${id}/`, cursor, limit: 1000 });
    if (page.objects.length === 0) break;
    await Promise.all(page.objects.map((o) => env.BUCKET.delete(o.key).then(() => { purged++; })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return purged;
}

/**
 * DELETE /api/cases/:id
 * → { ok: true, r2Purged: N }
 *
 * Removes everything tied to a case: R2 objects under cases/<id>/ AND the D1
 * `cases` row (cascades to members, hpo_terms, variants, evidence, jobs,
 * uploads, ...). Idempotent.
 */
apiRouter.delete("/cases/:id", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);

  const r2Purged = await purgeCaseR2(c.env, id);

  // FK cascade handles every child table. cases row may or may not exist
  // (legacy upload-only cases lacking a cases row); both are fine.
  await c.env.DB.prepare(`DELETE FROM cases WHERE id = ?`).bind(id).run();
  // Belt-and-suspenders in case a job/upload row exists without a cases row.
  await c.env.DB.prepare(`DELETE FROM jobs WHERE case_id = ?`).bind(id).run();
  await c.env.DB.prepare(`DELETE FROM uploads WHERE case_id = ?`).bind(id).run();

  return c.json({ ok: true, r2Purged });
});

/**
 * POST /api/cases/:id/recover
 *
 * Rebuild D1 rows (cases + uploads) for a case whose VCFs are still in R2 but
 * whose D1 state was wiped (e.g. after a Delete that didn't purge R2, or a
 * D1 migration). Doesn't re-create the manifest (pedigree/HPO are lost), so
 * after recovery the user must navigate to `/cases/<id>` and fill in the
 * pedigree + click Run again — but the VCFs don't need re-uploading.
 *
 * Returns { ok, role_count, files: [role,...] }
 */
apiRouter.post("/cases/:id/recover", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);

  // Inventory the R2 directory.
  const inner = await c.env.BUCKET.list({ prefix: `cases/${id}/uploads/`, limit: 100 });
  if (inner.objects.length === 0) {
    return c.json({ error: "no uploads in R2 for this caseId" }, 404);
  }

  const roles: { role: string; r2_key: string; filename: string }[] = [];
  for (const obj of inner.objects) {
    // key shape: cases/<id>/uploads/<role>.<ext>
    const fname = obj.key.split("/").pop() ?? "";
    const role = fname.split(".")[0];
    if (!role || !ALLOWED_ROLES.has(role)) continue;
    roles.push({ role, r2_key: obj.key, filename: fname });
  }
  if (roles.length === 0) {
    return c.json({ error: "no valid role files found (expected proband/father/mother)" }, 400);
  }

  // Rebuild the cases row (idempotent).
  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft')
     ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Recovered ${id}`).run();
  // Rebuild the uploads rows.
  for (const r of roles) {
    await c.env.DB.prepare(
      `INSERT INTO uploads (case_id, role, r2_key, filename, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(case_id, role) DO UPDATE SET r2_key=excluded.r2_key`,
    ).bind(id, r.role, r.r2_key, r.filename, Date.now()).run();
  }
  return c.json({ ok: true, role_count: roles.length, files: roles.map((r) => r.role) });
});

/**
 * POST /api/cases/cleanup
 * Body: { olderThanMinutes?: number }   (default 30)
 *
 * Sweeps stuck/failed runs:
 *   - Every case where jobs.status = 'error'.
 *   - Every case where jobs.status = 'running' AND started_at older than
 *     `olderThanMinutes` ago (likely orphaned — the Fly machine got killed
 *     mid-job).
 *
 * Returns { deleted: [<caseId>...], r2Purged: N }.
 */
apiRouter.post("/cases/cleanup", async (c) => {
  let body: { olderThanMinutes?: number } = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  const olderThanMs = (body.olderThanMinutes ?? 30) * 60 * 1000;
  const cutoff = Date.now() - olderThanMs;

  const rows = await c.env.DB.prepare(
    `SELECT case_id FROM jobs
       WHERE status = 'error'
          OR (status = 'running' AND COALESCE(started_at, 0) < ?)
          OR (status = 'queued'  AND COALESCE(started_at, 0) < ?)`,
  ).bind(cutoff, cutoff).all<{ case_id: string }>();

  const deleted: string[] = [];
  let r2Purged = 0;
  for (const row of rows.results ?? []) {
    const id = row.case_id;
    r2Purged += await purgeCaseR2(c.env, id);
    await c.env.DB.prepare(`DELETE FROM cases WHERE id = ?`).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM jobs WHERE case_id = ?`).bind(id).run();
    await c.env.DB.prepare(`DELETE FROM uploads WHERE case_id = ?`).bind(id).run();
    deleted.push(id);
  }
  return c.json({ deleted, r2Purged });
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
