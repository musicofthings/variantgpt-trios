/** Data-library client — the FTP-synced sample folders in R2 (data/incoming/). */
import { api, apiFetch } from "./apiBase";

export interface LibraryFile {
  key: string;
  name: string;
  kind: "fastq" | "vcf";
  mate: "R1" | "R2" | "";
  size: number;
}

export interface LibrarySample {
  sample: string;       // = patient folder name (PHI — shown only in the authed app)
  paired: boolean;      // has FASTQ R1 + R2
  r1: string | null;
  r2: string | null;
  vcf: string | null;   // partner-called VCF (fast path), when present
  files: LibraryFile[];
}

export async function fetchLibrarySamples(q?: string): Promise<LibrarySample[]> {
  const url = api(`/data/samples${q ? `?q=${encodeURIComponent(q)}` : ""}`);
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`data/samples ${r.status}`);
  const j = (await r.json()) as { samples: LibrarySample[] };
  return j.samples ?? [];
}

/** Point a case's roles at existing library objects (no upload). */
export async function assignDataToCase(
  caseId: string,
  assignments: { role: string; mate: "R1" | "R2" | ""; key: string }[],
): Promise<void> {
  const r = await apiFetch(api(`/cases/${caseId}/data-assign`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignments }),
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `data-assign ${r.status}`);
  }
}

export function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
