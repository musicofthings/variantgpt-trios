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
import { olsSelect } from "../hpo";
import { buildReportHtml, type ReportEmission } from "../report";

export const apiRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ───────────────────────── helpers ─────────────────────────

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const ALLOWED_ROLES = new Set(["proband", "father", "mother", "sibling", "relative"]);
const ALLOWED_EXTS = new Set(["vcf", "vcf.gz", "bam", "cram", "fastq.gz", "fq.gz"]);
// FASTQ is paired: a member has an R1 and R2 upload. VCF/BAM use mate=''.
const ALLOWED_MATES = new Set(["", "R1", "R2"]);

function sanitize(id: string): string | null {
  return SAFE_ID.test(id) ? id : null;
}

/** R2 object key for an uploaded blob. FASTQ encodes the mate so R1/R2 don't
 *  collide: cases/<id>/uploads/<role>.R1.fastq.gz */
function uploadKey(id: string, role: string, mate: string, ext: string): string {
  return mate
    ? `cases/${id}/uploads/${role}.${mate}.${ext}`
    : `cases/${id}/uploads/${role}.${ext}`;
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
  if (lower.endsWith(".cram")) return "cram";
  if (lower.endsWith(".fastq.gz")) return "fastq.gz";
  if (lower.endsWith(".fq.gz")) return "fq.gz";
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

  // olsSelect hits OLS's /select autocomplete endpoint — prefix matching on
  // label + synonym fields, which /search does not. "microceph" matches
  // "Microcephaly" via /select; via /search it returns 0 results.
  const results = await olsSelect(q, limit);

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
  const mate = c.req.query("mate") ?? "";
  if (!id) return c.json({ error: "bad caseId" }, 400);
  if (!ALLOWED_ROLES.has(role)) return c.json({ error: "bad role" }, 400);
  if (!ALLOWED_MATES.has(mate)) return c.json({ error: "bad mate (allowed: R1, R2)" }, 400);
  const ext = pickExt(filename ?? undefined);
  if (!ext || !ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "unsupported file extension (allowed: vcf, vcf.gz, bam, cram, fastq.gz, fq.gz)" }, 400);
  }

  const key = uploadKey(id, role, mate, ext);
  const url = await signR2(c.env, "variantgpt", key, "PUT", 3600);

  // The case row MUST exist before the uploads row — uploads.case_id has a
  // FOREIGN KEY into cases(id). Order matters; don't reorder these.
  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft')
     ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Case ${id}`).run();
  await c.env.DB.prepare(
    `INSERT INTO uploads (case_id, role, mate, r2_key, filename, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, role, mate) DO UPDATE SET
       r2_key=excluded.r2_key, filename=excluded.filename, uploaded_at=excluded.uploaded_at`,
  ).bind(id, role, mate, key, filename ?? null, Date.now()).run();

  return c.json({ url, key, expiresIn: 3600, role, mate, filename: filename ?? null });
});

// ───────────────────────── multipart upload (huge BAM/CRAM) ─────────────────────────
//
// A single presigned PUT caps at R2's 5 GB single-object-PUT limit and isn't
// resumable. WGS BAMs run 50–150 GB, so large files go through S3-compatible
// multipart upload: the client splits the file into parts, PUTs each part
// directly to R2 via a presigned URL (bytes never touch the Worker), and we
// stitch them with CompleteMultipartUpload.
//
// NOTE: the bucket needs a CORS policy allowing PUT from the SPA origin and
// exposing the `ETag` response header (the browser must read each part's ETag
// to send back at completion). Configure once on the R2 bucket.

const R2_BUCKET = "variantgpt";
// S3 requires every part except the last to be ≥ 5 MiB. We advertise 64 MiB
// so a 150 GB BAM is ~2400 parts (well under the 10 000-part ceiling).
const MULTIPART_PART_SIZE = 64 * 1024 * 1024;

function xmlTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return m ? m[1] : null;
}

async function createMultipart(env: Bindings, key: string, contentType?: string): Promise<string> {
  const aws = r2Client(env);
  const url = `${r2Endpoint(env.R2_ACCOUNT_ID)}/${R2_BUCKET}/${encodeURI(key)}?uploads`;
  const res = await aws.fetch(url, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
  });
  if (!res.ok) throw new Error(`CreateMultipartUpload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const uploadId = xmlTag(await res.text(), "UploadId");
  if (!uploadId) throw new Error("CreateMultipartUpload returned no UploadId");
  return uploadId;
}

async function signPartUrl(env: Bindings, key: string, uploadId: string, partNumber: number): Promise<string> {
  const aws = r2Client(env);
  const url =
    `${r2Endpoint(env.R2_ACCOUNT_ID)}/${R2_BUCKET}/${encodeURI(key)}` +
    `?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}&X-Amz-Expires=86400`;
  const signed = await aws.sign(new Request(url, { method: "PUT" }), { aws: { signQuery: true } });
  return signed.url;
}

async function completeMultipart(
  env: Bindings, key: string, uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<void> {
  const aws = r2Client(env);
  const body =
    "<CompleteMultipartUpload>" +
    parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";
  const url = `${r2Endpoint(env.R2_ACCOUNT_ID)}/${R2_BUCKET}/${encodeURI(key)}?uploadId=${encodeURIComponent(uploadId)}`;
  const res = await aws.fetch(url, { method: "POST", body, headers: { "content-type": "application/xml" } });
  if (!res.ok) throw new Error(`CompleteMultipartUpload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function abortMultipart(env: Bindings, key: string, uploadId: string): Promise<void> {
  const aws = r2Client(env);
  const url = `${r2Endpoint(env.R2_ACCOUNT_ID)}/${R2_BUCKET}/${encodeURI(key)}?uploadId=${encodeURIComponent(uploadId)}`;
  await aws.fetch(url, { method: "DELETE" });
}

/**
 * POST /api/cases/:id/uploads/:role/multipart?filename=foo.bam
 * → { uploadId, key, partSize }
 *
 * Begin a resumable multipart upload for a large aligned-reads file. The client
 * then requests a presigned URL per part and PUTs chunks directly to R2.
 */
apiRouter.post("/cases/:id/uploads/:role/multipart", async (c) => {
  const id = sanitize(c.req.param("id"));
  const role = c.req.param("role");
  const filename = c.req.query("filename") ?? undefined;
  const mate = c.req.query("mate") ?? "";
  if (!id) return c.json({ error: "bad caseId" }, 400);
  if (!ALLOWED_ROLES.has(role)) return c.json({ error: "bad role" }, 400);
  if (!ALLOWED_MATES.has(mate)) return c.json({ error: "bad mate (allowed: R1, R2)" }, 400);
  const ext = pickExt(filename);
  if (!ext || !ALLOWED_EXTS.has(ext)) {
    return c.json({ error: "unsupported file extension (allowed: vcf, vcf.gz, bam, cram, fastq.gz, fq.gz)" }, 400);
  }

  const key = uploadKey(id, role, mate, ext);
  let uploadId: string;
  try {
    uploadId = await createMultipart(c.env, key, "application/octet-stream");
  } catch (e) {
    return c.json({ error: `multipart init failed: ${String(e).slice(0, 200)}` }, 502);
  }

  // Ensure the cases row exists (uploads.case_id FK) before we record anything.
  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft') ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Case ${id}`).run();

  return c.json({ uploadId, key, partSize: MULTIPART_PART_SIZE, role, mate, filename: filename ?? null });
});

/**
 * GET /api/cases/:id/uploads/:role/multipart/:uploadId/part?key=<key>&partNumber=<n>
 * → { url } — presigned PUT for one part (valid 24h, since huge uploads are slow).
 */
apiRouter.get("/cases/:id/uploads/:role/multipart/:uploadId/part", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const uploadId = c.req.param("uploadId");
  const key = c.req.query("key");
  const partNumber = parseInt(c.req.query("partNumber") ?? "", 10);
  if (!key || !key.startsWith(`cases/${id}/uploads/`)) return c.json({ error: "bad key" }, 400);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: "partNumber must be 1..10000" }, 400);
  }
  const url = await signPartUrl(c.env, key, uploadId, partNumber);
  return c.json({ url, partNumber });
});

/**
 * POST /api/cases/:id/uploads/:role/multipart/:uploadId/complete
 *   body = { key, filename?, parts: [{ partNumber, etag }] }
 * → { ok, key } — stitches the parts and records the uploads row.
 */
apiRouter.post("/cases/:id/uploads/:role/multipart/:uploadId/complete", async (c) => {
  const id = sanitize(c.req.param("id"));
  const role = c.req.param("role");
  if (!id) return c.json({ error: "bad caseId" }, 400);
  if (!ALLOWED_ROLES.has(role)) return c.json({ error: "bad role" }, 400);
  const uploadId = c.req.param("uploadId");
  const body = await c.req.json<{ key: string; filename?: string; mate?: string; parts: { partNumber: number; etag: string }[] }>();
  const mate = body?.mate ?? "";
  if (!body?.key || !body.key.startsWith(`cases/${id}/uploads/`)) return c.json({ error: "bad key" }, 400);
  if (!ALLOWED_MATES.has(mate)) return c.json({ error: "bad mate" }, 400);
  if (!Array.isArray(body.parts) || body.parts.length === 0) return c.json({ error: "no parts" }, 400);

  try {
    await completeMultipart(c.env, body.key, uploadId, body.parts);
  } catch (e) {
    return c.json({ error: `multipart complete failed: ${String(e).slice(0, 200)}` }, 502);
  }

  await c.env.DB.prepare(
    `INSERT INTO uploads (case_id, role, mate, r2_key, filename, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(case_id, role, mate) DO UPDATE SET
       r2_key=excluded.r2_key, filename=excluded.filename, uploaded_at=excluded.uploaded_at`,
  ).bind(id, role, mate, body.key, body.filename ?? null, Date.now()).run();

  return c.json({ ok: true, key: body.key, role, mate });
});

/**
 * DELETE /api/cases/:id/uploads/:role/multipart/:uploadId?key=<key>
 * → { ok } — abort an in-progress multipart upload (frees R2 part storage).
 */
apiRouter.delete("/cases/:id/uploads/:role/multipart/:uploadId", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const uploadId = c.req.param("uploadId");
  const key = c.req.query("key");
  if (!key || !key.startsWith(`cases/${id}/uploads/`)) return c.json({ error: "bad key" }, 400);
  await abortMultipart(c.env, key, uploadId);
  return c.json({ ok: true });
});

// ───────────────────────── data library (FTP-synced samples) ─────────────────────────
//
// The partner lab's SFTP is synced daily into R2 under data/incoming/<sample>/
// (one folder per sample) by tracks/sync_ftp_to_r2.sh. The Data section browses
// these and assigns a sample's R1/R2 to a case role WITHOUT any download/upload —
// the engine pulls the data/ keys straight from R2.

const DATA_PREFIX = "data/incoming/";

/** Infer the paired-end mate from a FASTQ filename (Illumina conventions). */
function detectFastqMate(name: string): "R1" | "R2" | "" {
  const n = name.toLowerCase();
  if (n.includes("_r1") || n.includes(".r1.") || n.includes("_1.fastq") || n.includes("_1.fq")) return "R1";
  if (n.includes("_r2") || n.includes(".r2.") || n.includes("_2.fastq") || n.includes("_2.fq")) return "R2";
  return "";
}

function isFastqName(name: string): boolean {
  return /\.(fastq|fq)(\.gz)?$/i.test(name);
}

/**
 * GET /api/data/samples?q=<substr>
 * → { samples: [{ sample, paired, r1, r2, files:[{key,name,mate,size}] }] }
 *
 * One folder per sample under data/incoming/. Lists folders, then the FASTQs in
 * each, grouping R1/R2. Optional `q` filters by sample-folder name.
 */
apiRouter.get("/data/samples", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase();

  // 1. Sample folders (R2 list with delimiter → delimitedPrefixes).
  const folders: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.BUCKET.list({ prefix: DATA_PREFIX, delimiter: "/", cursor, limit: 1000 });
    for (const p of page.delimitedPrefixes ?? []) folders.push(p);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // 2. Files per folder (cap the number of folders we expand per request).
  const samples: Array<{
    sample: string; paired: boolean; r1: string | null; r2: string | null;
    files: { key: string; name: string; mate: string; size: number }[];
  }> = [];
  for (const folder of folders) {
    const sample = folder.slice(DATA_PREFIX.length).replace(/\/$/, "");
    if (q && !sample.toLowerCase().includes(q)) continue;
    if (samples.length >= 500) break; // safety cap

    const files: { key: string; name: string; mate: string; size: number }[] = [];
    let ic: string | undefined;
    do {
      const inner = await c.env.BUCKET.list({ prefix: folder, cursor: ic, limit: 1000 });
      for (const o of inner.objects) {
        const name = o.key.split("/").pop() ?? "";
        if (!isFastqName(name)) continue;
        files.push({ key: o.key, name, mate: detectFastqMate(name), size: o.size });
      }
      ic = inner.truncated ? inner.cursor : undefined;
    } while (ic);
    if (files.length === 0) continue;

    const r1 = files.find((f) => f.mate === "R1");
    const r2 = files.find((f) => f.mate === "R2");
    samples.push({ sample, paired: !!(r1 && r2), r1: r1?.key ?? null, r2: r2?.key ?? null, files });
  }

  samples.sort((a, b) => a.sample.localeCompare(b.sample));
  return c.json({ samples });
});

/**
 * POST /api/cases/:id/data-assign
 *   body = { assignments: [{ role, mate, key }] }
 * → { ok, assigned }
 *
 * Point a case's uploads at existing data-library R2 objects (no copy). The
 * normal /run path then signs these keys for the engine. Keys must live under
 * data/ and the objects must exist.
 */
apiRouter.post("/cases/:id/data-assign", async (c) => {
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);
  const body = await c.req.json<{ assignments: { role: string; mate: string; key: string }[] }>();
  if (!Array.isArray(body?.assignments) || body.assignments.length === 0) {
    return c.json({ error: "no assignments" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft') ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Case ${id}`).run();

  let assigned = 0;
  for (const a of body.assignments) {
    const mate = a.mate ?? "";
    if (!ALLOWED_ROLES.has(a.role)) return c.json({ error: `bad role ${a.role}` }, 400);
    if (!ALLOWED_MATES.has(mate)) return c.json({ error: `bad mate ${mate}` }, 400);
    if (!a.key || !a.key.startsWith("data/")) return c.json({ error: `key must be under data/: ${a.key}` }, 400);
    if (!(await c.env.BUCKET.head(a.key).catch(() => null))) {
      return c.json({ error: `data object not found: ${a.key}` }, 404);
    }
    const filename = a.key.split("/").pop() ?? null;
    await c.env.DB.prepare(
      `INSERT INTO uploads (case_id, role, mate, r2_key, filename, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(case_id, role, mate) DO UPDATE SET
         r2_key=excluded.r2_key, filename=excluded.filename, uploaded_at=excluded.uploaded_at`,
    ).bind(id, a.role, mate, a.key, filename, Date.now()).run();
    assigned++;
  }
  return c.json({ ok: true, assigned });
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
  // a half-populated case. Group by role (a FASTQ role has R1 + R2 mates).
  const uploads = await c.env.DB.prepare(
    `SELECT role, mate, r2_key FROM uploads WHERE case_id = ?`,
  ).bind(id).all<{ role: string; mate: string; r2_key: string }>();
  const byRole = new Map<string, { mate: string; key: string }[]>();
  for (const r of uploads.results ?? []) {
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role)!.push({ mate: r.mate ?? "", key: r.r2_key });
  }
  for (const role of Object.keys(manifest.files)) {
    if (!byRole.has(role)) {
      return c.json({ error: `no uploaded file found for role=${role}` }, 400);
    }
  }
  return _continueRun(c, id, manifest, byRole);
}

async function _continueRun(
  c: import("hono").Context<{ Bindings: Bindings; Variables: Variables }>,
  id: string,
  manifest: CaseManifest,
  byRole: Map<string, { mate: string; key: string }[]>,
) {

  // Mint signed URLs for the container, routing each role by upload kind:
  //   FASTQ (R1/R2 mates) → fastq_urls → engine aligns (BWA-MEM) then calls
  //   .bam/.cram          → bam_urls   → engine GATK-calls
  //   .vcf(.gz)           → vcf_urls   → straight to annotation
  const vcfUrls: Record<string, string> = {};
  const bamUrls: Record<string, string> = {};
  const fastqUrls: Record<string, { r1: string; r2: string | null }> = {};
  for (const [role, blobs] of byRole.entries()) {
    const r1 = blobs.find((b) => b.mate === "R1");
    const r2 = blobs.find((b) => b.mate === "R2");
    if (r1) {
      fastqUrls[role] = {
        r1: await signR2(c.env, "variantgpt", r1.key, "GET", 24 * 3600),
        r2: r2 ? await signR2(c.env, "variantgpt", r2.key, "GET", 24 * 3600) : null,
      };
      continue;
    }
    const blob = blobs.find((b) => b.mate === "") ?? blobs[0];
    const signed = await signR2(c.env, "variantgpt", blob.key, "GET", 24 * 3600);
    const lower = blob.key.toLowerCase();
    if (lower.endsWith(".bam") || lower.endsWith(".cram")) bamUrls[role] = signed;
    else vcfUrls[role] = signed;
  }
  const needsReference = Object.keys(bamUrls).length > 0 || Object.keys(fastqUrls).length > 0;

  // Reference + known-sites for GATK calling / alignment — needed when BAM or
  // FASTQ inputs are present. Configured as R2 keys on the Worker; when reads
  // are uploaded but no reference is configured, fail fast with a clear message.
  // (FASTQ also needs the engine's on-volume BWA index via REFERENCE_FASTA_PATH.)
  let referenceUrl: string | undefined;
  let referenceFaiUrl: string | undefined;
  let referenceDictUrl: string | undefined;
  const knownSitesUrls: string[] = [];
  if (needsReference) {
    if (!c.env.REFERENCE_FASTA_KEY) {
      return c.json({
        error: "BAM/FASTQ upload requires a reference genome, but REFERENCE_FASTA_KEY is not configured on this Worker",
        hint: "set REFERENCE_FASTA_KEY (+ optional REFERENCE_FAI_KEY / REFERENCE_DICT_KEY / KNOWN_SITES_KEYS) to the R2 keys of the reference FASTA. FASTQ also needs the engine's on-volume BWA index (REFERENCE_FASTA_PATH).",
      }, 400);
    }
    referenceUrl = await signR2(c.env, "variantgpt", c.env.REFERENCE_FASTA_KEY, "GET", 24 * 3600);
    if (c.env.REFERENCE_FAI_KEY) referenceFaiUrl = await signR2(c.env, "variantgpt", c.env.REFERENCE_FAI_KEY, "GET", 24 * 3600);
    if (c.env.REFERENCE_DICT_KEY) referenceDictUrl = await signR2(c.env, "variantgpt", c.env.REFERENCE_DICT_KEY, "GET", 24 * 3600);
    for (const ksKey of (c.env.KNOWN_SITES_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      knownSitesUrls.push(await signR2(c.env, "variantgpt", ksKey, "GET", 24 * 3600));
    }
  }

  // SV/CNV: a pre-computed AnnotSV TSV (produced upstream from GATK gCNV/Manta)
  // is signed when present so the engine can classify CNVs (ClinGen 2019).
  let svAnnotsvUrl: string | undefined;
  const svKey = `cases/${id}/uploads/sv.annotsv.tsv`;
  if (await c.env.BUCKET.head(svKey).catch(() => null)) {
    svAnnotsvUrl = await signR2(c.env, "variantgpt", svKey, "GET", 24 * 3600);
  }

  // gCNV cohort-model bundle — when BAMs are present and a panel-of-normals
  // bundle + intervals are configured, the engine calls CNVs from the proband
  // BAM (GATK gCNV CASE) → AnnotSV → ClinGen-2019 classification.
  let gcnvModelUrl: string | undefined;
  let gcnvIntervalsUrl: string | undefined;
  if (Object.keys(bamUrls).length > 0 && c.env.GCNV_MODEL_TGZ_KEY && c.env.GCNV_INTERVALS_KEY) {
    gcnvModelUrl = await signR2(c.env, "variantgpt", c.env.GCNV_MODEL_TGZ_KEY, "GET", 24 * 3600);
    gcnvIntervalsUrl = await signR2(c.env, "variantgpt", c.env.GCNV_INTERVALS_KEY, "GET", 24 * 3600);
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
    // variants_v8: per-variant phenotype_relevance (coverage / resnik / phrank
    //              HPO proximity scores). Bump invalidates v7 so variants are
    //              re-scored against the case's HPO terms via the hp.obo DAG.
    variants: await signCacheStage("variants_v8"),
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
      // Raw-reads path — present only when FASTQ was uploaded; the engine
      // aligns (BWA-MEM) then GATK-calls. {role: {r1, r2|null}}.
      fastq_urls: fastqUrls,
      // Aligned-reads path (GATK best practices) — present only when BAM/CRAM
      // were uploaded; the engine calls them to VCF before annotation.
      bam_urls: bamUrls,
      reference_url: referenceUrl,
      reference_fai_url: referenceFaiUrl,
      reference_dict_url: referenceDictUrl,
      known_sites_urls: knownSitesUrls,
      // SV/CNV classification input (pre-annotated AnnotSV TSV), when present.
      sv_annotsv_url: svAnnotsvUrl,
      // gCNV cohort-model bundle — drives BAM→CNV calling in the engine.
      gcnv_model_url: gcnvModelUrl,
      gcnv_intervals_url: gcnvIntervalsUrl,
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
 * GET|POST /api/cases/:id/report?format=html|pdf&variants=id1,id2
 *   → a self-contained, print-ready clinical report rendered server-side from
 *     case.json. No client JS, no /api calls — a stable archival artifact.
 *
 * Variant selection: ?variants=<comma ids> (GET) or { variants: string[] } in
 * the POST body. When omitted, archival mode renders reclassified-first, then
 * highest-priority variants (capped).
 *
 * format=html (default) → text/html.
 * format=pdf → server-renders to PDF via the Cloudflare Browser Rendering REST
 *   API when BROWSER_RENDERING_TOKEN (+ R2_ACCOUNT_ID) is configured; otherwise
 *   501 with a pointer to the HTML form (the browser's own Print-to-PDF already
 *   produces a clean clinical PDF from the SPA).
 */
apiRouter.all("/cases/:id/report", async (c) => {
  const method = c.req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return c.json({ error: "method not allowed" }, 405);
  }
  const id = sanitize(c.req.param("id"));
  if (!id) return c.json({ error: "bad caseId" }, 400);

  const obj = await c.env.BUCKET.get(`cases/${id}/case.json`);
  if (!obj) return c.json({ error: "case.json not found" }, 404);
  let emission: ReportEmission;
  try {
    emission = (await obj.json()) as ReportEmission;
  } catch {
    return c.json({ error: "case.json is not valid JSON" }, 500);
  }

  // Variant selection — query string, plus POST-body { variants } if present.
  let selected: string[] | undefined;
  const q = c.req.query("variants");
  if (q) selected = q.split(",").map((s) => s.trim()).filter(Boolean);
  if (method === "POST") {
    try {
      const body = (await c.req.json()) as { variants?: string[] };
      if (Array.isArray(body?.variants)) selected = body.variants.filter(Boolean);
    } catch {
      /* no/empty body is fine */
    }
  }

  const html = buildReportHtml(emission, selected);
  const format = (c.req.query("format") ?? "html").toLowerCase();

  if (format !== "pdf") {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // PDF path — Cloudflare Browser Rendering REST API.
  const token = c.env.BROWSER_RENDERING_TOKEN;
  const account = c.env.R2_ACCOUNT_ID;
  if (!token || !account) {
    return c.json(
      {
        error: "PDF rendering is not configured on this worker",
        hint: "request ?format=html and use the browser's Print → Save as PDF, or set BROWSER_RENDERING_TOKEN",
      },
      501,
    );
  }

  let pdfResp: Response;
  try {
    pdfResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/browser-rendering/pdf`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ html }),
      },
    );
  } catch (e) {
    return c.json({ error: `browser rendering unreachable: ${String(e).slice(0, 200)}` }, 502);
  }
  if (!pdfResp.ok) {
    const txt = await pdfResp.text().catch(() => "");
    return c.json({ error: `browser rendering ${pdfResp.status}: ${txt.slice(0, 300)}` }, 502);
  }

  return new Response(pdfResp.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="variantgpt-${id}.pdf"`,
    },
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

  const roles: { role: string; mate: string; r2_key: string; filename: string }[] = [];
  for (const obj of inner.objects) {
    // key shape: cases/<id>/uploads/<role>[.<mate>].<ext>  (mate = R1/R2 for FASTQ)
    const fname = obj.key.split("/").pop() ?? "";
    const parts = fname.split(".");
    const role = parts[0];
    const mate = parts[1] === "R1" || parts[1] === "R2" ? parts[1] : "";
    if (!role || !ALLOWED_ROLES.has(role)) continue;
    roles.push({ role, mate, r2_key: obj.key, filename: fname });
  }
  if (roles.length === 0) {
    return c.json({ error: "no valid role files found (expected proband/father/mother)" }, 400);
  }

  // Rebuild the cases row (idempotent).
  await c.env.DB.prepare(
    `INSERT INTO cases (id, name, status) VALUES (?, ?, 'draft')
     ON CONFLICT(id) DO NOTHING`,
  ).bind(id, `Recovered ${id}`).run();
  // Rebuild the uploads rows (PK is (case_id, role, mate) since migration 0003).
  for (const r of roles) {
    await c.env.DB.prepare(
      `INSERT INTO uploads (case_id, role, mate, r2_key, filename, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(case_id, role, mate) DO UPDATE SET r2_key=excluded.r2_key`,
    ).bind(id, r.role, r.mate, r.r2_key, r.filename, Date.now()).run();
  }
  return c.json({
    ok: true,
    role_count: roles.length,
    files: roles.map((r) => (r.mate ? `${r.role}.${r.mate}` : r.role)),
  });
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
