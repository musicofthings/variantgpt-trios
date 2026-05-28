/** In-browser VCF/BAM header sniff (PRD §4.1: "let the user map VCF sample →
 * pedigree member if names don't match"). We read the first chunk of the file,
 * gunzip it if needed (DecompressionStream('gzip')), and:
 *   - For VCF: parse the #CHROM header line → return sample names + ref build
 *   - For BAM: validate the BAM\1 magic bytes
 * Everything stays client-side; no upload happens here.
 */
import type { AcceptedKind } from "./components/FileDropzone";

export interface SniffResult {
  samples: string[];
  build?: "GRCh37" | "GRCh38" | "unknown";
  contigs?: string[];
  error?: string;
  ok: boolean;
}

const HEAD_BYTES = 256 * 1024; // 256KB is plenty for any VCF header

export async function sniffFile(file: File, kind: AcceptedKind): Promise<SniffResult> {
  try {
    if (kind === "bam") return await sniffBam(file);
    if (kind === "bai") return { samples: [], ok: true };
    return await sniffVcf(file, kind === "vcf_gz");
  } catch (e) {
    return { samples: [], ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sniffVcf(file: File, gzipped: boolean): Promise<SniffResult> {
  const slice = file.slice(0, gzipped ? HEAD_BYTES : HEAD_BYTES);
  let stream: ReadableStream<Uint8Array> = slice.stream();
  if (gzipped) {
    if (typeof DecompressionStream === "undefined") {
      return { samples: [], ok: false, error: "Browser lacks DecompressionStream; cannot sniff .gz" };
    }
    stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
  const text = await readText(stream, HEAD_BYTES);
  return parseVcfHeader(text);
}

function parseVcfHeader(text: string): SniffResult {
  const lines = text.split(/\r?\n/);
  const contigs: string[] = [];
  let build: SniffResult["build"] = "unknown";
  for (const line of lines) {
    if (line.startsWith("##contig=")) {
      const m = line.match(/ID=([^,>]+)/);
      if (m) contigs.push(m[1]);
      // Length-based build guess: chr1 length 248956422 = GRCh38; 249250621 = GRCh37.
      if (/ID=(chr)?1[,>]/.test(line)) {
        if (/length=248956422/.test(line)) build = "GRCh38";
        else if (/length=249250621/.test(line)) build = "GRCh37";
      }
    }
    if (line.startsWith("##reference")) {
      if (/grch?38|hg38/i.test(line)) build = "GRCh38";
      else if (/grch?37|hg19/i.test(line)) build = "GRCh37";
    }
    if (line.startsWith("#CHROM")) {
      const cols = line.split("\t");
      const fmtIdx = cols.indexOf("FORMAT");
      const samples = fmtIdx >= 0 ? cols.slice(fmtIdx + 1) : [];
      return { samples, build, contigs, ok: true };
    }
  }
  return { samples: [], ok: false, error: "VCF header (#CHROM line) not found in first 256KB — file may not be a VCF." };
}

/** BAM is BGZF, which starts with the gzip magic 1f 8b 08 04. After
 * decompressing the first BGZF block, the payload begins with the literal
 * ASCII "BAM\1" (4 bytes). We only validate the magic — full BAM header parse
 * needs an actual library. */
async function sniffBam(file: File): Promise<SniffResult> {
  const head = await file.slice(0, 64 * 1024).arrayBuffer();
  const bytes = new Uint8Array(head);
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    return { samples: [], ok: false, error: "Not a gzip/BGZF stream — file may be corrupt or not a BAM." };
  }
  // Try to decompress the first block.
  if (typeof DecompressionStream !== "undefined") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
      const reader = stream.getReader();
      const first = await reader.read();
      reader.cancel();
      if (first.value && first.value.length >= 4) {
        const m = first.value.slice(0, 4);
        if (m[0] === 0x42 && m[1] === 0x41 && m[2] === 0x4d && m[3] === 0x01) {
          return { samples: [], ok: true, build: "unknown" };
        }
        return { samples: [], ok: false, error: "BGZF block did not begin with BAM\\1 magic — file may be a regular gzip, not BAM." };
      }
    } catch {
      // Fall through to a soft-pass: we accept the file but flag it.
    }
  }
  return { samples: [], ok: true, build: "unknown" };
}

async function readText(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Heuristic: map a VCF sample name (and optionally the filename it came
 *  from) onto a pedigree role. Permissive by design — clinical labs use
 *  patient-name-derived sample IDs ("DOE-JOHN_GM00020390_proband") and
 *  rarely match the literal role string. The user can still override via
 *  the "Reassign to" / "Use anyway" controls if we get it wrong.
 *
 *  Matches (case-insensitive, against either sample name or filename):
 *    1. Exact role: "proband", "father", "mother"
 *    2. Substring: "..._proband_...", "...father.vcf", etc.
 *    3. Family-relation synonyms: dad/papa/sire → father; mom/mama/dam → mother;
 *       child/patient/index/case/affected/pt → proband
 *    4. Common abbreviations: prob/proband/p_/p1/p2 → proband;
 *       fath/fa/f_/f1 → father; moth/mo/m_/m1 → mother
 *    5. Terminal suffixes: "_P", "_F", "_M", "-P", "-F", "-M" (case-insensitive)
 *    6. GIAB / Coriell sample IDs (HG002 / NA24385, etc.)
 */
export function autoMapSample(sample: string, role: string, filename?: string): boolean {
  const r = role.toLowerCase();
  // Build the haystack: VCF header sample plus filename minus extension.
  const hayParts = [sample.toLowerCase()];
  if (filename) {
    hayParts.push(
      filename
        .toLowerCase()
        .replace(/\.(vcf\.gz|vcf|bam|bai|gz)$/i, ""),
    );
  }
  const hay = hayParts.join(" ");

  // 1. Trivial cases first.
  if (hay === r) return true;
  if (hay.includes(r)) return true;

  // 2. GIAB / Coriell aliases — these come pre-set in benchmark VCFs.
  const GIAB: Record<string, string> = {
    hg002: "proband", na24385: "proband",
    hg003: "father",  na24149: "father",
    hg004: "mother",  na24143: "mother",
  };
  for (const part of hayParts) {
    if (GIAB[part] === r) return true;
  }

  // 3. Role-keyword aliases (each list ∋ canonical role + synonyms + abbrevs).
  const ALIASES: Record<string, string[]> = {
    proband: [
      "proband", "prob", "probandus",
      "child", "patient", "index", "case", "affected", "pt",
      "p1", "p2",   // sample index when there's a single proband
    ],
    father: [
      "father", "fath", "dad", "daddy", "papa", "pop", "sire", "paternal",
      "f1", "f2",
    ],
    mother: [
      "mother", "moth", "mom", "mommy", "mama", "mum", "dam", "maternal",
      "m1", "m2",
    ],
    sibling: ["sibling", "sib", "brother", "sister", "bro", "sis"],
  };
  const aliases = ALIASES[r] ?? [r];

  // Tokenize the haystack on common separators so we match word-bounded
  // tokens (not e.g. "case" matching inside "downstream").
  const tokens = hay.split(/[\s_\-.,;:|/\\()[\]]+/).filter(Boolean);
  for (const tok of tokens) {
    if (aliases.includes(tok)) return true;
  }

  // 4. Terminal single-letter suffix: "..._P" / "...-P" / "...P1".
  // Map _P→proband, _F→father, _M→mother. Check the original (raw) parts
  // so the suffix has its case preserved before the lowercase fold.
  const SUFFIX: Record<string, string> = {
    P: "proband", F: "father", M: "mother", S: "sibling", C: "proband",
  };
  for (const raw of [sample, filename ?? ""]) {
    if (!raw) continue;
    const m = raw.match(/[_\-]([PFMSC])\d?$/i);
    if (m && SUFFIX[m[1].toUpperCase()] === r) return true;
  }

  return false;
}
