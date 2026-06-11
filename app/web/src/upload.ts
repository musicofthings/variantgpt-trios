/** Direct-to-R2 upload client.
 *
 * Two paths, chosen by size:
 *   - small files  → one presigned PUT (GET /upload-url/:role).
 *   - large files (BAM/CRAM, or anything over MULTIPART_THRESHOLD) → S3
 *     multipart upload: init → per-part presigned PUT (direct to R2, so the
 *     Worker never sees the bytes) → complete. Resumable-friendly and not
 *     bound by R2's 5 GB single-PUT cap, so multi-GB WGS BAMs go through here.
 *
 * Bytes always stream straight to R2 — never through the Worker.
 */
import { api, apiFetch } from "./apiBase";

// Above this, use multipart. 64 MiB matches the server's advertised part size.
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;

export interface UploadProgress {
  /** 0..1 fraction of bytes uploaded. */
  fraction: number;
  uploadedBytes: number;
  totalBytes: number;
}

export type ProgressFn = (p: UploadProgress) => void;

/** Upload one staged file to R2 under cases/<caseId>/uploads/<role>[.<mate>].<ext>.
 *  `mate` is "R1"/"R2" for paired FASTQ, "" for VCF/BAM. Returns the R2 key.
 *  Picks single-PUT or multipart automatically by size. */
export async function uploadStaged(
  caseId: string,
  role: string,
  file: File,
  onProgress?: ProgressFn,
  mate: "" | "R1" | "R2" = "",
): Promise<string> {
  if (file.size <= MULTIPART_THRESHOLD) {
    return singlePut(caseId, role, file, mate, onProgress);
  }
  return multipartUpload(caseId, role, file, mate, onProgress);
}

async function singlePut(caseId: string, role: string, file: File, mate: string, onProgress?: ProgressFn): Promise<string> {
  const q = `filename=${encodeURIComponent(file.name)}${mate ? `&mate=${mate}` : ""}`;
  const r = await apiFetch(api(`/cases/${caseId}/upload-url/${role}?${q}`));
  if (!r.ok) throw new Error(`signing ${role} failed: ${r.status}`);
  const { url, key } = (await r.json()) as { url: string; key: string };
  const put = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error(`upload ${role} failed: ${put.status}`);
  onProgress?.({ fraction: 1, uploadedBytes: file.size, totalBytes: file.size });
  return key;
}

async function multipartUpload(caseId: string, role: string, file: File, mate: string, onProgress?: ProgressFn): Promise<string> {
  // 1. init
  const q = `filename=${encodeURIComponent(file.name)}${mate ? `&mate=${mate}` : ""}`;
  const initRes = await apiFetch(
    api(`/cases/${caseId}/uploads/${role}/multipart?${q}`),
    { method: "POST" },
  );
  if (!initRes.ok) throw new Error(`multipart init ${role} failed: ${initRes.status}`);
  const { uploadId, key, partSize } = (await initRes.json()) as {
    uploadId: string; key: string; partSize: number;
  };

  const size = partSize || MULTIPART_THRESHOLD;
  const partCount = Math.ceil(file.size / size);
  const parts: { partNumber: number; etag: string }[] = [];
  let uploadedBytes = 0;

  try {
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const start = (partNumber - 1) * size;
      const blob = file.slice(start, Math.min(start + size, file.size));

      // presign this part
      const urlRes = await apiFetch(
        api(`/cases/${caseId}/uploads/${role}/multipart/${uploadId}/part?key=${encodeURIComponent(key)}&partNumber=${partNumber}`),
      );
      if (!urlRes.ok) throw new Error(`part ${partNumber} sign failed: ${urlRes.status}`);
      const { url } = (await urlRes.json()) as { url: string };

      const put = await fetch(url, { method: "PUT", body: blob });
      if (!put.ok) throw new Error(`part ${partNumber} upload failed: ${put.status}`);
      // R2 returns the part ETag; the bucket CORS policy must expose it.
      const etag = put.headers.get("ETag") || put.headers.get("etag");
      if (!etag) throw new Error(`part ${partNumber}: no ETag in response (check bucket CORS expose-headers: ETag)`);
      parts.push({ partNumber, etag });

      uploadedBytes += blob.size;
      onProgress?.({ fraction: uploadedBytes / file.size, uploadedBytes, totalBytes: file.size });
    }

    // 3. complete
    const done = await apiFetch(
      api(`/cases/${caseId}/uploads/${role}/multipart/${uploadId}/complete`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, filename: file.name, mate, parts }),
      },
    );
    if (!done.ok) throw new Error(`multipart complete ${role} failed: ${done.status}`);
    return key;
  } catch (e) {
    // Best-effort abort to free part storage; ignore failures.
    await apiFetch(
      api(`/cases/${caseId}/uploads/${role}/multipart/${uploadId}?key=${encodeURIComponent(key)}`),
      { method: "DELETE" },
    ).catch(() => undefined);
    throw e;
  }
}
