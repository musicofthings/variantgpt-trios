import { useRef, useState } from "react";

export type AcceptedKind = "vcf" | "vcf_gz" | "bam" | "bai" | "fastq" | "unknown";

export interface StagedFile {
  file: File;
  kind: AcceptedKind;
  sample?: string | null;
  error?: string;
}

const ACCEPT = ".vcf,.vcf.gz,.gz,.bam,.bai,.cram,.fastq,.fq,.fastq.gz,.fq.gz";

/** Drop-zone for Illumina WES/WGS inputs (PRD §4.1 VCF upload).
 *
 * Accepts: .vcf, .vcf.gz, .gz (assumed VCF), .bam, .bam.bai. Validates by
 * extension; deeper magic-byte / header sniffing happens in vcfSniff.ts after
 * the file is staged. The component itself is intentionally headless about
 * what's been "uploaded" — the parent owns staging + progress. */
export function FileDropzone({
  label,
  hint,
  staged,
  onStage,
  onClear,
}: {
  label: string;
  hint?: string;
  staged?: StagedFile | null;
  onStage: (file: StagedFile) => void;
  onClear?: () => void;
}) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File) {
    const kind = detectKind(f.name);
    if (kind === "unknown") {
      onStage({ file: f, kind, error: "Unsupported format. Accepts .vcf, .vcf.gz, .bam, .bam.bai" });
      return;
    }
    // Large files (WGS BAM/CRAM run 50–150 GB) are uploaded as a resumable S3
    // multipart upload directly to R2, so size is not a blocker — just stage it.
    onStage({ file: f, kind });
  }

  return (
    <div
      className={`drop ${drag ? "drop-over" : ""} ${staged?.error ? "drop-error" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      onClick={() => !staged && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label={`Upload ${label}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
      <div className="drop-label"><strong>{label}</strong></div>
      {staged?.file ? (
        <div className="drop-staged">
          <div className="drop-filename mono" title={staged.file.name}>{truncate(staged.file.name, 38)}</div>
          <div className="drop-meta">
            <KindBadge kind={staged.kind} />
            <span className="mono">{human(staged.file.size)}</span>
            {staged.sample ? <span className="mono">sample={staged.sample}</span> : null}
          </div>
          {staged.error ? <div className="drop-err">{staged.error}</div> : null}
          {onClear ? (
            <button
              className="drop-clear"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              aria-label="Remove file"
            >Remove</button>
          ) : null}
        </div>
      ) : (
        <div className="drop-empty">
          <div>{hint ?? "Drop .vcf / .vcf.gz / .bam here, or click to browse"}</div>
          <div className="drop-formats">Illumina WES / WGS · GRCh37/38 auto-detected</div>
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: AcceptedKind }) {
  const map: Record<AcceptedKind, { label: string; color: string }> = {
    vcf:    { label: "VCF",    color: "var(--primary)" },
    vcf_gz: { label: "VCF.gz", color: "var(--primary)" },
    bam:    { label: "BAM",    color: "var(--tier-lb)" },
    bai:    { label: "BAI",    color: "var(--ink-soft)" },
    fastq:  { label: "FASTQ",  color: "var(--tier-lb)" },
    unknown: { label: "?",     color: "var(--accent)" },
  };
  const { label, color } = map[kind];
  return (
    <span
      className="kind-badge mono"
      style={{ color, borderColor: color }}
    >{label}</span>
  );
}

export function detectKind(name: string): AcceptedKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".vcf")) return "vcf";
  if (lower.endsWith(".vcf.gz") || lower.endsWith(".vcf.bgz")) return "vcf_gz";
  if (lower.endsWith(".bam") || lower.endsWith(".cram")) return "bam";
  if (lower.endsWith(".bai") || lower.endsWith(".bam.bai") || lower.endsWith(".crai")) return "bai";
  // FASTQ (raw reads) — paired R1/R2 handled by the Intake page.
  if (lower.endsWith(".fastq.gz") || lower.endsWith(".fq.gz") ||
      lower.endsWith(".fastq") || lower.endsWith(".fq")) return "fastq";
  // Some pipelines emit `*.gz` for a bgzipped VCF.
  if (lower.endsWith(".gz")) return "vcf_gz";
  return "unknown";
}

function human(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 8) + "…" + s.slice(-7);
}
