/**
 * Local Vite middleware emulating the Cloudflare Workers API surface (PRD §6.6).
 *
 * What it owns during local dev:
 *   POST   /api/uploads/:caseId/:role        ← raw body = file bytes
 *   POST   /api/cases/:caseId/run            ← body = manifest JSON
 *   GET    /api/cases/:caseId                ← case.json (engine output)
 *   GET    /api/cases/:caseId/status         ← {status: queued|running|ready|error, ...}
 *
 * Files land under  D:\Projects\VariantGPT\data\uploads\<caseId>\
 * The engine is invoked via  python tracks/run_uploaded_case.py <caseId>
 * Output lands at            app/web/public/cases/<caseId>/case.json
 *
 * This is a dev-only shim. Deploying to Cloudflare uses Workers + R2 + D1.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isLive, latestByVariant, proposalFingerprint, validateDecision,
  type DecisionInput, type DecisionRecord, type ProposalLike,
} from "./src/decisionRules";

const REPO_ROOT = resolve(__dirname, "..", "..");
const UPLOAD_ROOT = resolve(REPO_ROOT, "data", "uploads");
const PUBLIC_CASES = resolve(__dirname, "public", "cases");
const ENGINE_RUNNER = resolve(REPO_ROOT, "tracks", "run_uploaded_case.py");

// Hard cap on a single uploaded VCF/BAM, in bytes. The UI dropzone warns at
// 10 GB but doesn't actually block; this is the dev server's last line.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

// Allowed file extensions on uploads. Anything else is rejected — prevents
// path traversal via crafted x-filename headers.
const ALLOWED_EXT = new Set(["vcf", "vcf.gz", "bam"]);

// Honor an env var so an operator can pin the engine interpreter on Windows
// (where `python` may resolve to the Store stub or a wrong conda env).
const PYTHON_BIN = process.env.VARIANTGPT_PYTHON || "python";

type JobStatus = "queued" | "running" | "ready" | "error";

interface Job {
  caseId: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  log: string[];
  manifest?: { fileCount?: number; memberCount?: number; missingCount?: number };
}

const jobs = new Map<string, Job>();

function statusPath(caseId: string) {
  return resolve(UPLOAD_ROOT, caseId, "status.json");
}

function persistJob(job: Job) {
  try {
    const p = statusPath(job.caseId);
    mkdirSync(dirname(p), { recursive: true });
    const toWrite = { ...job, log: job.log.slice(-50) };
    require("node:fs").writeFileSync(p, JSON.stringify(toWrite, null, 2), "utf-8");
  } catch {
    // Best-effort; in-memory state is the source of truth during a run.
  }
}

async function loadPersistedJob(caseId: string): Promise<Job | null> {
  try {
    const txt = await readFile(statusPath(caseId), "utf-8");
    return JSON.parse(txt) as Job;
  } catch {
    return null;
  }
}

export function devCaseApi(): Plugin {
  return {
    name: "variantgpt-dev-case-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();

        try {
          // GET /api/cases/:caseId/upload-url/:role?filename=...
          // Mirrors the Worker contract; dev returns a URL that points back
          // at our own PUT handler so the SPA upload path is identical in
          // dev and prod.
          const signReq = url.match(/^\/api\/cases\/([^/?]+)\/upload-url\/([^/?]+)(?:\?(.*))?$/);
          if (signReq && req.method === "GET") {
            return await handleSignUploadUrl(req, res, signReq[1], signReq[2]);
          }
          // PUT /api/uploads/:caseId/:role  (used by the URL we hand back above)
          const putUp = url.match(/^\/api\/uploads\/([^/?]+)\/([^/?]+)/);
          if (putUp && req.method === "PUT") {
            return await handleUpload(req, res, putUp[1], putUp[2]);
          }
          // POST /api/uploads/:caseId/:role  (legacy direct-POST path)
          const up = url.match(/^\/api\/uploads\/([^/?]+)\/([^/?]+)/);
          if (up && req.method === "POST") {
            return await handleUpload(req, res, up[1], up[2]);
          }
          // POST /api/cases/:caseId/run
          const run = url.match(/^\/api\/cases\/([^/?]+)\/run/);
          if (run && req.method === "POST") {
            return await handleRun(req, res, run[1]);
          }
          // GET /api/cases/:caseId/status
          const status = url.match(/^\/api\/cases\/([^/?]+)\/status/);
          if (status && req.method === "GET") {
            return await handleStatus(res, status[1]);
          }
          // GET /api/cases  (list)
          if (url.match(/^\/api\/cases\/?$/) && req.method === "GET") {
            return await handleListCases(res);
          }
          // GET /api/cases/:caseId
          const get = url.match(/^\/api\/cases\/([^/?]+)$/);
          if (get && req.method === "GET") {
            return await handleGetCase(res, get[1]);
          }
          // DELETE /api/cases/:caseId
          const del = url.match(/^\/api\/cases\/([^/?]+)$/);
          if (del && req.method === "DELETE") {
            return await handleDeleteCase(res, del[1]);
          }
          // POST /api/cases/cleanup
          if (url.match(/^\/api\/cases\/cleanup\/?$/) && req.method === "POST") {
            return await handleCleanup(req, res);
          }
          // GET|POST /api/cases/:caseId/decisions — curator sign-off (PRD §4.10)
          const dec = url.match(/^\/api\/cases\/([^/?]+)\/decisions\/?$/);
          if (dec && req.method === "GET") {
            return await handleGetDecisions(res, dec[1]);
          }
          if (dec && req.method === "POST") {
            return await handlePostDecision(req, res, dec[1]);
          }
          return notFound(res);
        } catch (e) {
          return error(res, 500, e instanceof Error ? e.message : String(e));
        }
      });
    },
  };
}

async function handleSignUploadUrl(
  req: IncomingMessage, res: ServerResponse, caseId: string, role: string,
) {
  const safeCase = sanitize(caseId);
  if (!safeCase) return error(res, 400, "bad caseId");
  if (!sanitize(role)) return error(res, 400, "bad role");
  // Echo a URL back to our own PUT handler. The x-filename hint isn't needed
  // when the client encodes the filename in the query string of the URL we
  // hand back, but Intake.tsx already sends ?filename=...; preserve it so
  // handleUpload picks up the extension via x-filename. We surface it in the
  // returned URL as a query param for visibility — actual ext parsing happens
  // on the PUT request via the same parseExt() the Worker uses (we forward
  // the filename through the request's own URL query → x-filename header).
  const qs = (req.url ?? "").split("?")[1] ?? "";
  const filename = new URLSearchParams(qs).get("filename") ?? undefined;
  const target = `/api/uploads/${safeCase}/${role}${filename ? `?filename=${encodeURIComponent(filename)}` : ""}`;
  return json(res, 200, { url: target, role, filename: filename ?? null, expiresIn: 3600 });
}

async function handleUpload(
  req: IncomingMessage, res: ServerResponse, caseId: string, role: string,
) {
  const safeCase = sanitize(caseId);
  const safeRole = sanitize(role);
  if (!safeCase || !safeRole) return error(res, 400, "bad caseId/role");

  // Filename comes via x-filename header (legacy POST flow) or ?filename=
  // query param (presigned-PUT flow). The presigned URL we hand back from
  // /upload-url embeds ?filename=... directly so the PUT-er doesn't have to
  // set any headers — matches how an R2 PUT works in prod.
  const qsFilename = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("filename");
  const hdrFilename = req.headers["x-filename"] as string | undefined;
  const ext = parseExt(qsFilename ?? hdrFilename);
  if (!ext) return error(res, 400, "unsupported file extension (allowed: vcf, vcf.gz, bam)");

  const dir = resolve(UPLOAD_ROOT, safeCase);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${safeRole}.${ext}`);
  // Defense in depth: even with sanitized inputs, refuse writes that escape
  // the upload directory.
  if (!path.startsWith(dir + require("node:path").sep)) {
    return error(res, 400, "resolved path escapes upload dir");
  }

  // CRITICAL: attach the write pipe synchronously, before any await — otherwise
  // Node auto-resumes the request stream and the body is lost.
  try {
    await pipeRequest(req, path, MAX_UPLOAD_BYTES);
  } catch (e) {
    return error(res, 413, e instanceof Error ? e.message : String(e));
  }
  const s = await stat(path);
  return json(res, 200, { ok: true, path, size: s.size, role: safeRole });
}

function parseExt(filename: string | undefined): string | null {
  if (!filename) return "vcf";
  // Strip any path components a malicious client might include.
  const base = filename.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  if (lower.endsWith(".vcf.gz")) return "vcf.gz";
  if (lower.endsWith(".vcf")) return "vcf";
  if (lower.endsWith(".bam")) return "bam";
  return null;
}

function pipeRequest(req: IncomingMessage, path: string, maxBytes: number): Promise<void> {
  return new Promise((done, fail) => {
    const w = createWriteStream(path);
    let bytes = 0;
    let aborted = false;
    const abort = (msg: string) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(w);
      w.destroy();
      // Best-effort cleanup of the partial file.
      try { require("node:fs").unlinkSync(path); } catch {}
      fail(new Error(msg));
    };
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) abort(`upload exceeds ${maxBytes} bytes`);
    });
    req.on("error", (e) => abort(e.message));
    w.on("error", (e) => abort(e.message));
    w.on("finish", () => { if (!aborted) done(); });
    req.pipe(w);
  });
}

async function handleRun(req: IncomingMessage, res: ServerResponse, caseId: string) {
  const safeCase = sanitize(caseId);
  if (!safeCase) return error(res, 400, "bad caseId");

  const body = await readJson<{
    pedigree: { id: string; role: string; sex: string; affected: boolean; sample_name?: string }[];
    consanguineous: boolean;
    hpo: string[];
    history?: string;
    files: Record<string, string>; // role -> uploaded filename (relative)
  }>(req);

  const dir = resolve(UPLOAD_ROOT, safeCase);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "manifest.json"), JSON.stringify(body, null, 2), "utf-8");

  const job: Job = {
    caseId: safeCase,
    status: "queued",
    startedAt: Date.now(),
    log: [],
    manifest: {
      memberCount: body.pedigree?.length,
      missingCount: body.pedigree?.filter((m) => (m as { missing?: boolean }).missing).length,
      fileCount: Object.keys(body.files ?? {}).length,
    },
  };
  jobs.set(safeCase, job);
  persistJob(job);

  // Kick off the engine asynchronously; client polls /status.
  spawnEngine(safeCase, job).catch((e) => {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
    job.finishedAt = Date.now();
    persistJob(job);
  });

  return json(res, 202, { ok: true, caseId: safeCase, status: job.status });
}

function spawnEngine(caseId: string, job: Job): Promise<void> {
  return new Promise((done) => {
    job.status = "running";
    persistJob(job);
    const proc = spawn(PYTHON_BIN, [ENGINE_RUNNER, caseId], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    const append = (d: Buffer) => {
      const s = d.toString();
      // Keep individual lines, drop trailing newline noise.
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) job.log.push(line);
      }
      persistJob(job);
    };
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    proc.on("error", (e) => {
      job.status = "error";
      job.error = e.message;
      job.finishedAt = Date.now();
      persistJob(job);
      done();
    });
    proc.on("close", (code) => {
      job.finishedAt = Date.now();
      if (code === 0) job.status = "ready";
      else {
        job.status = "error";
        job.error = `engine exited ${code}`;
      }
      persistJob(job);
      done();
    });
  });
}

async function handleStatus(res: ServerResponse, caseId: string) {
  const safe = sanitize(caseId);
  if (!safe) return error(res, 400, "bad caseId");
  let job = jobs.get(safe) ?? (await loadPersistedJob(safe));
  if (!job) return json(res, 200, { status: "unknown" });
  return json(res, 200, {
    status: job.status,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    manifest: job.manifest,
    log: job.log.slice(-15),
  });
}

async function handleListCases(res: ServerResponse) {
  const out: Array<{
    caseId: string;
    status: JobStatus | "unknown";
    startedAt?: number;
    finishedAt?: number;
    fileCount?: number;
    memberCount?: number;
    missingCount?: number;
    error?: string;
    hasResult: boolean;
  }> = [];

  // Scan upload root for any case with a manifest or status file.
  let uploadIds: string[] = [];
  try { uploadIds = (await readdir(UPLOAD_ROOT)).filter((n) => !n.startsWith(".")); } catch {}
  const seen = new Set<string>();
  for (const id of uploadIds) {
    if (!sanitize(id)) continue;
    seen.add(id);
    const job = jobs.get(id) ?? (await loadPersistedJob(id));
    const resultExists = existsSync(resolve(PUBLIC_CASES, id, "case.json"));
    out.push({
      caseId: id,
      status: job?.status ?? (resultExists ? "ready" : "unknown"),
      startedAt: job?.startedAt,
      finishedAt: job?.finishedAt,
      fileCount: job?.manifest?.fileCount,
      memberCount: job?.manifest?.memberCount,
      missingCount: job?.manifest?.missingCount,
      error: job?.error,
      hasResult: resultExists,
    });
  }
  // Catch result-only cases (no upload trace).
  try {
    const resultIds = await readdir(PUBLIC_CASES);
    for (const id of resultIds) {
      if (seen.has(id)) continue;
      if (!sanitize(id)) continue;
      out.push({ caseId: id, status: "ready", hasResult: true });
    }
  } catch {}

  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return json(res, 200, { cases: out });
}

async function handleGetCase(res: ServerResponse, caseId: string) {
  const safe = sanitize(caseId);
  if (!safe) return error(res, 400, "bad caseId");
  const path = resolve(PUBLIC_CASES, safe, "case.json");
  if (!existsSync(path)) return error(res, 404, "case.json not found");
  const body = await readFile(path, "utf-8");
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

/** Dev-only: remove a case's on-disk artifacts (uploads + generated case.json)
 *  and drop its in-memory job state. Mirrors the Worker's DELETE /api/cases/:id. */
async function purgeCaseLocal(caseId: string): Promise<number> {
  const fs = await import("node:fs/promises");
  let purged = 0;
  for (const dir of [resolve(UPLOAD_ROOT, caseId), resolve(PUBLIC_CASES, caseId)]) {
    if (!existsSync(dir)) continue;
    try {
      const entries = await fs.readdir(dir);
      purged += entries.length;
      await fs.rm(dir, { recursive: true, force: true });
    } catch { /* ignore best-effort */ }
  }
  jobs.delete(caseId);
  return purged;
}

async function handleDeleteCase(res: ServerResponse, caseId: string) {
  const safe = sanitize(caseId);
  if (!safe) return error(res, 400, "bad caseId");
  const r2Purged = await purgeCaseLocal(safe);
  return json(res, 200, { ok: true, r2Purged });
}

async function handleCleanup(req: IncomingMessage, res: ServerResponse) {
  let body: { olderThanMinutes?: number } = {};
  try { body = await readJson<typeof body>(req); } catch { /* tolerate empty */ }
  const cutoff = Date.now() - (body.olderThanMinutes ?? 30) * 60 * 1000;

  const deleted: string[] = [];
  let r2Purged = 0;

  // Sweep in-memory + persisted jobs first.
  let uploadIds: string[] = [];
  try { uploadIds = (await readdir(UPLOAD_ROOT)).filter((n) => !n.startsWith(".")); } catch {}
  for (const id of uploadIds) {
    if (!sanitize(id)) continue;
    const job = jobs.get(id) ?? (await loadPersistedJob(id));
    if (!job) continue;
    const stuck = (job.status === "running" || job.status === "queued") && job.startedAt < cutoff;
    if (job.status === "error" || stuck) {
      r2Purged += await purgeCaseLocal(id);
      deleted.push(id);
    }
  }
  return json(res, 200, { deleted, r2Purged });
}

// ───────── helpers ─────────

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

// ───────────────── curator sign-off (PRD §4.10) ─────────────────
//
// Dev stand-in for the Worker's D1 `reclass_decisions` table: an append-only
// JSON array next to the case's uploads. Same rules as prod — the validation
// and fingerprinting come from src/decisions.ts, which the SPA also uses, so
// there's exactly one implementation of the invariant on this side.

function decisionsPath(caseId: string) {
  return resolve(UPLOAD_ROOT, caseId, "decisions.json");
}

/** Stored newest-first, matching the Worker's `ORDER BY decided_at DESC`. */
async function readDecisions(caseId: string): Promise<DecisionRecord[]> {
  try {
    const txt = await readFile(decisionsPath(caseId), "utf-8");
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
  } catch {
    return []; // no decisions recorded yet
  }
}

/** Proposals from the generated case.json, keyed by variant id. */
async function readProposals(caseId: string): Promise<Map<string, ProposalLike> | null> {
  try {
    const txt = await readFile(resolve(PUBLIC_CASES, caseId, "case.json"), "utf-8");
    const emission = JSON.parse(txt) as { proposals?: ProposalLike[] };
    return new Map((emission.proposals ?? []).map((p) => [p.variant_id, p]));
  } catch {
    return null;
  }
}

async function handleGetDecisions(res: ServerResponse, caseId: string) {
  const safe = sanitize(caseId);
  if (!safe) return error(res, 400, "bad caseId");

  const rows = await readDecisions(safe);
  const proposals = await readProposals(safe);
  const staleOf = (d: DecisionRecord) => (proposals ? !isLive(proposals.get(d.variant_id), d) : false);

  const live = latestByVariant(rows);
  const pending = proposals
    ? [...proposals.keys()].filter((vid) => {
        const d = live.get(vid);
        return !d || !isLive(proposals.get(vid), d);
      })
    : [];

  return json(res, 200, {
    decisions: [...live.values()].map((d) => ({ ...d, stale: staleOf(d) })),
    history: rows.map((d) => ({ ...d, stale: staleOf(d) })),
    pending,
    proposal_count: proposals?.size ?? 0,
  });
}

async function handlePostDecision(req: IncomingMessage, res: ServerResponse, caseId: string) {
  const safe = sanitize(caseId);
  if (!safe) return error(res, 400, "bad caseId");

  const body = await readJson<{ variant_id?: string } & DecisionInput>(req);
  const variantId = typeof body.variant_id === "string" ? body.variant_id : "";
  if (!variantId) return error(res, 400, "variant_id is required");

  const proposals = await readProposals(safe);
  if (!proposals) return error(res, 404, "case.json not found — run the case first");
  const proposal = proposals.get(variantId);
  if (!proposal) return error(res, 404, "no reclassification proposal for this variant");

  const v = validateDecision(body, proposal);
  if (!v.ok) return error(res, 400, v.error);

  const row: DecisionRecord = {
    id: randomUUID(),
    case_id: safe,
    variant_id: variantId,
    action: v.action,
    from_tier: proposal.from_tier,
    proposed_tier: proposal.to_tier,
    final_tier: v.final_tier,
    // Dev has no Clerk session; the Worker stamps the real Clerk `sub`.
    curator: "dev-unauthenticated",
    curator_name: v.curator_name,
    note: v.note,
    proposal_fingerprint: proposalFingerprint(proposal),
    decided_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    stale: false,
  };

  // Append-only: prepend so the file stays newest-first, never rewrite a row.
  const rows = await readDecisions(safe);
  await mkdir(dirname(decisionsPath(safe)), { recursive: true });
  await writeFile(decisionsPath(safe), JSON.stringify([row, ...rows], null, 2), "utf-8");

  return json(res, 201, { decision: row });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
function error(res: ServerResponse, status: number, message: string) {
  return json(res, status, { error: message });
}
function notFound(res: ServerResponse) {
  return json(res, 404, { error: "not found" });
}
function sanitize(s: string): string {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(s) ? s : "";
}
