/** Franklin (Genoox) ↔ VariantGPT diff view.
 *
 *  Drop a Franklin "Export → CSV" file in. We join by (chr, pos, ref, alt),
 *  then bucket each row as:
 *
 *    - BOTH_AGREE     in both, tiers match (or our reclass matches Franklin)
 *    - BOTH_DIFFER    in both, tiers differ → side-by-side comparison
 *    - FRANKLIN_ONLY  in Franklin's set, not in ours → we filtered it out
 *                     (Franklin's filtering defaults are different — they
 *                     keep more borderline calls by default)
 *    - VARIANTGPT_ONLY  in our set, not in Franklin's → they filtered it out
 *
 *  Goal isn't to declare a winner. It's to make divergence VISIBLE so the
 *  curator can decide variant-by-variant whether we missed a real call or
 *  whether Franklin is including noise. Cross-check the BOTH_DIFFER rows
 *  against the ClinVar Audit panel — if Franklin says LP and ClinVar says
 *  LP and we say VUS, we have a real gap to close.
 *
 *  Franklin's CSV column layout (as of 2026): see SAMPLE_HEADER in the
 *  parser. We extract Gene, Chr, Start Position, Ref, Alt, Nucleotide
 *  (HGVS c.), AA Change (HGVS p.), Genoox Classification, and the
 *  Father/Mother zygosity triplet. Everything else is ignored.
 */
import { useMemo, useRef, useState } from "react";
import type { Tier, VariantRow } from "../types";

interface FranklinRow {
  gene: string;
  chr: string;
  pos: number;
  ref: string;
  alt: string;
  hgvs_c?: string;
  hgvs_p?: string;
  genoox_class?: string;
  proband_zyg?: string;
  father_zyg?: string;
  mother_zyg?: string;
  inheritance?: string;
  clinvar_class?: string;
  aggregated_af?: number | null;
}

type Bucket =
  | "BOTH_AGREE"
  | "BOTH_DIFFER"
  | "FRANKLIN_ONLY"
  | "VARIANTGPT_ONLY";

interface DiffRow {
  bucket: Bucket;
  v?: VariantRow;
  f?: FranklinRow;
  /** Joint identity key for this row. */
  key: string;
  /** Our tier, when present. */
  ours?: Tier;
  /** Franklin's tier mapped onto our vocabulary, when present. */
  theirs?: Tier;
}

/** Map Franklin's "Genoox Classification" string onto our Tier vocab.
 *  Returns null when unclassified / unknown. Franklin uses many sub-flavors
 *  of "Uncertain" — we collapse them all to VUS for comparison purposes. */
function genooxToTier(s: string | undefined): Tier | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("conflict")) return null;
  if (t.includes("likely pathogenic")) return "LP";
  if (t.includes("pathogenic")) return "P";
  if (t.includes("likely benign")) return "LB";
  if (t.includes("benign")) return "B";
  if (t.includes("uncertain")) return "VUS";
  return null;
}

const HEADER_ALIASES: Record<string, string[]> = {
  gene: ["Gene"],
  chr: ["Chr", "Chromosome"],
  pos: ["Start Position", "Position", "Start"],
  ref: ["Ref", "Reference"],
  alt: ["Alt", "Alternate"],
  hgvs_c: ["Nucleotide", "HGVSc", "HGVS c."],
  hgvs_p: ["AA Change", "HGVSp", "HGVS p.", "Amino Acid Change"],
  genoox_class: ["Genoox Classification", "Genoox Class", "Classification"],
  proband_zyg: ["Zygosity"],
  father_zyg: ["Father - Zygosity", "Father Zygosity"],
  mother_zyg: ["Mother - Zygosity", "Mother Zygosity"],
  inheritance: ["Inheritance Model", "Inheritance"],
  clinvar_class: ["ClinVar Classification", "ClinVar"],
  aggregated_af: ["Aggregated Frequency", "AF"],
};

function parseCsv(text: string): FranklinRow[] {
  // Minimal CSV parser handling double-quoted fields with embedded commas.
  // Franklin's exports don't normally embed commas in cells we care about,
  // but the column count is 60+ so robustness is worth the small parser.
  const lines: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cur.push(cell); cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(cell); cell = "";
      if (cur.length > 1 || cur[0] !== "") lines.push(cur);
      cur = [];
    } else cell += c;
  }
  if (cell !== "" || cur.length) { cur.push(cell); lines.push(cur); }

  if (lines.length < 2) return [];
  const header = lines[0];

  // Resolve each logical field to a column index using aliases.
  const idx: Record<string, number> = {};
  for (const [logical, aliases] of Object.entries(HEADER_ALIASES)) {
    const hit = aliases.find((a) => header.indexOf(a) >= 0);
    idx[logical] = hit ? header.indexOf(hit) : -1;
  }

  const get = (row: string[], k: string): string => {
    const i = idx[k];
    return i >= 0 && i < row.length ? (row[i] ?? "").trim() : "";
  };

  const rows: FranklinRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row || row.every((c) => c === "")) continue;
    const chrRaw = get(row, "chr");
    const posStr = get(row, "pos");
    const ref = get(row, "ref");
    const alt = get(row, "alt");
    const pos = parseInt(posStr, 10);
    if (!chrRaw || !ref || !alt || Number.isNaN(pos)) continue;
    const afStr = get(row, "aggregated_af");
    const af = afStr && afStr !== "N/A" ? parseFloat(afStr) : null;
    rows.push({
      gene: get(row, "gene"),
      chr: normChr(chrRaw),
      pos,
      ref,
      alt,
      hgvs_c: get(row, "hgvs_c") || undefined,
      hgvs_p: get(row, "hgvs_p") || undefined,
      genoox_class: get(row, "genoox_class") || undefined,
      proband_zyg: get(row, "proband_zyg") || undefined,
      father_zyg: get(row, "father_zyg") || undefined,
      mother_zyg: get(row, "mother_zyg") || undefined,
      inheritance: get(row, "inheritance") || undefined,
      clinvar_class: get(row, "clinvar_class") || undefined,
      aggregated_af: Number.isFinite(af) ? af : null,
    });
  }
  return rows;
}

function normChr(c: string): string {
  return c.startsWith("chr") ? c : `chr${c}`;
}

function keyOf(chr: string, pos: number, ref: string, alt: string): string {
  return `${normChr(chr)}:${pos}:${ref}:${alt}`;
}

export function FranklinDiff({ variants }: { variants: VariantRow[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [franklin, setFranklin] = useState<FranklinRow[] | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [bucketFilter, setBucketFilter] = useState<Bucket | "ALL">("BOTH_DIFFER");
  const [err, setErr] = useState<string | null>(null);

  async function handleFile(file: File) {
    setErr(null);
    setFilename(file.name);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) {
        setErr("Parsed 0 variants — is this a Franklin CSV export?");
        setFranklin(null);
        return;
      }
      setFranklin(rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setFranklin(null);
    }
  }

  // Build the diff once both sides are present.
  const diff = useMemo<DiffRow[]>(() => {
    if (!franklin) return [];
    const byKey = new Map<string, VariantRow>();
    for (const v of variants) {
      if (!v.chrom || v.pos == null || !v.ref || !v.alt) continue;
      byKey.set(keyOf(v.chrom, v.pos, v.ref, v.alt), v);
    }
    const seen = new Set<string>();
    const out: DiffRow[] = [];
    for (const f of franklin) {
      const k = keyOf(f.chr, f.pos, f.ref, f.alt);
      seen.add(k);
      const v = byKey.get(k);
      const theirs = genooxToTier(f.genoox_class);
      if (!v) {
        out.push({ bucket: "FRANKLIN_ONLY", f, key: k, theirs: theirs ?? undefined });
        continue;
      }
      const ours = v.baseline_tier;
      const ourReclass = v.reclass?.to ?? null;
      const agree = theirs && (ours === theirs || ourReclass === theirs);
      out.push({
        bucket: agree ? "BOTH_AGREE" : "BOTH_DIFFER",
        v, f, key: k, ours, theirs: theirs ?? undefined,
      });
    }
    for (const v of variants) {
      if (!v.chrom || v.pos == null || !v.ref || !v.alt) continue;
      const k = keyOf(v.chrom, v.pos, v.ref, v.alt);
      if (seen.has(k)) continue;
      out.push({ bucket: "VARIANTGPT_ONLY", v, key: k, ours: v.baseline_tier });
    }
    return out;
  }, [franklin, variants]);

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = {
      BOTH_AGREE: 0, BOTH_DIFFER: 0, FRANKLIN_ONLY: 0, VARIANTGPT_ONLY: 0,
    };
    for (const d of diff) c[d.bucket] += 1;
    return c;
  }, [diff]);

  const filtered = bucketFilter === "ALL" ? diff : diff.filter((d) => d.bucket === bucketFilter);

  // ── render ─────────────────────────────────────────────────────────
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ marginRight: 8 }}>Franklin (Genoox) diff</h3>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <button onClick={() => fileRef.current?.click()}>
          {franklin ? "Load different CSV" : "Load Franklin CSV"}
        </button>
        {franklin ? (
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
            {filename} · {franklin.length} variants imported
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
            Drop a Franklin → Export → CSV file to see the side-by-side diff.
          </span>
        )}
      </div>

      {err ? <p style={{ color: "var(--rust, #b04a2a)", fontSize: 12, marginTop: 8 }}>{err}</p> : null}

      {franklin && diff.length > 0 ? (
        <>
          {/* Calibration caveat — Franklin pulls from GenomeAsia 100K in
              their internal annotation pipeline (per Genoox product
              communications, not documented in their public PM2/BS1
              article). When we don't have GenomeAsia loaded, a chunk of
              divergences in BOTH_DIFFER / FRANKLIN_ONLY are
              GA100K-driven and will close on our side once
              GENOMEASIA_R2_PREFIX is set — see GenomeAsia_config.md.
              This banner prevents the curator from over-reading those
              divergences as our pipeline being wrong. */}
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              fontSize: 11,
              color: "var(--ink-soft)",
              border: "1px solid var(--rule)",
              background: "var(--paper-soft, #f6f1e6)",
              borderRadius: 4,
              lineHeight: 1.5,
            }}
          >
            <strong>Calibration note:</strong> Franklin uses GenomeAsia 100K
            internally for South-Asian variant classification. If
            VariantGPT's GenomeAsia track isn't loaded yet (see{" "}
            <code className="mono">GenomeAsia_config.md</code>), expect some
            divergences in <em>Franklin only</em> / <em>both differ</em>
            to close automatically once it's activated — they reflect a
            missing data source, not an ACMG implementation gap.
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", fontSize: 12 }}>
            {(["ALL", "BOTH_DIFFER", "FRANKLIN_ONLY", "VARIANTGPT_ONLY", "BOTH_AGREE"] as const).map((b) => {
              const n = b === "ALL" ? diff.length : counts[b];
              return (
                <button
                  key={b}
                  onClick={() => setBucketFilter(b)}
                  disabled={n === 0}
                  style={{
                    padding: "3px 12px", borderRadius: 999,
                    border: "1px solid var(--rule)",
                    background: bucketFilter === b ? "var(--primary-soft)" : "var(--paper)",
                    fontSize: 11,
                    opacity: n === 0 ? 0.4 : 1,
                  }}
                >
                  {labelFor(b)} ({n})
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Concordance on shared variants:{" "}
            <strong className="mono" style={{ color: counts.BOTH_AGREE > counts.BOTH_DIFFER ? "var(--success, #2c8462)" : "var(--rust, #b04a2a)" }}>
              {counts.BOTH_AGREE}/{counts.BOTH_AGREE + counts.BOTH_DIFFER} agree
              ({((counts.BOTH_AGREE / Math.max(1, counts.BOTH_AGREE + counts.BOTH_DIFFER)) * 100).toFixed(0)}%)
            </strong>
            {". "}
            <strong className="mono">{counts.FRANKLIN_ONLY}</strong> in Franklin only,{" "}
            <strong className="mono">{counts.VARIANTGPT_ONLY}</strong> in VariantGPT only.{" "}
            Click any row to inspect the variant.
          </div>

          <table className="table" style={{ marginTop: 10, fontSize: 12 }}>
            <thead>
              <tr>
                <th>Gene · HGVS</th>
                <th>Locus</th>
                <th>VariantGPT</th>
                <th>Franklin (Genoox)</th>
                <th>Bucket</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((d) => <Row key={d.key} d={d} />)}
              {filtered.length > 200 ? (
                <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--ink-soft)" }}>
                  + {filtered.length - 200} more (filter to narrow down)
                </td></tr>
              ) : null}
            </tbody>
          </table>

          <p style={{ marginTop: 10, fontSize: 11, color: "var(--ink-soft)", lineHeight: 1.5 }}>
            Variants are joined by (chrom, pos, ref, alt). Franklin's "Uncertain - Possibly Pathogenic/Benign (Moderate/Strong)"
            sub-flavors all collapse to VUS for tier comparison — Franklin's threshold for graduating from VUS to LP is
            generally lower than ours, so a Franklin "Uncertain - Possibly Pathogenic (Moderate)" + our VUS is concordant
            from a tier-vocabulary standpoint.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Row({ d }: { d: DiffRow }) {
  const gene = d.v?.gene ?? d.f?.gene ?? "—";
  const hgvs_c = d.v?.hgvs_c ?? d.f?.hgvs_c ?? "";
  const hgvs_p = d.v?.hgvs_p ?? d.f?.hgvs_p ?? "";
  const chr = d.v?.chrom ?? d.f?.chr ?? "";
  const pos = d.v?.pos ?? d.f?.pos ?? "";
  const ref = d.v?.ref ?? d.f?.ref ?? "";
  const alt = d.v?.alt ?? d.f?.alt ?? "";

  return (
    <tr>
      <td className="mono">
        <strong>{gene}</strong> {hgvs_c}
        {hgvs_p ? <span style={{ color: "var(--ink-soft)" }}> {hgvs_p}</span> : null}
      </td>
      <td className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
        {chr}:{pos} {ref}→{alt}
      </td>
      <td>
        {d.ours ? (
          <>
            <strong>{d.ours}</strong>
            {d.v?.reclass ? <span style={{ color: "var(--ink-soft)" }}> → {d.v.reclass.to}</span> : null}
          </>
        ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}
      </td>
      <td>
        {d.theirs ? <strong>{d.theirs}</strong> : <span style={{ color: "var(--ink-soft)" }}>—</span>}
        {d.f?.genoox_class ? (
          <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{d.f.genoox_class}</div>
        ) : null}
      </td>
      <td><BucketLabel bucket={d.bucket} /></td>
      <td style={{ color: "var(--ink-soft)", fontSize: 11, maxWidth: 300 }}>
        {noteFor(d)}
      </td>
    </tr>
  );
}

function labelFor(b: Bucket | "ALL"): string {
  switch (b) {
    case "ALL": return "All";
    case "BOTH_AGREE": return "Both agree";
    case "BOTH_DIFFER": return "Both differ";
    case "FRANKLIN_ONLY": return "Franklin only";
    case "VARIANTGPT_ONLY": return "VariantGPT only";
  }
}

function BucketLabel({ bucket }: { bucket: Bucket }) {
  const cfg: Record<Bucket, { text: string; color: string }> = {
    BOTH_AGREE:       { text: "agree",         color: "var(--success, #2c8462)" },
    BOTH_DIFFER:      { text: "differ",        color: "var(--rust, #b04a2a)" },
    FRANKLIN_ONLY:    { text: "Franklin only", color: "var(--ink-soft)" },
    VARIANTGPT_ONLY:  { text: "VariantGPT only", color: "var(--ink-soft)" },
  };
  const c = cfg[bucket];
  return <span style={{ color: c.color, fontWeight: 500, fontSize: 11 }}>{c.text}</span>;
}

/** Generate a one-line explanatory note for each diff row to save the
 *  curator from squinting at the raw data. */
function noteFor(d: DiffRow): string {
  if (d.bucket === "BOTH_AGREE") {
    if (d.v?.reclass && d.v.reclass.to === d.theirs) {
      return "Our South-Asian reclassification (post-IndiGen) lines up with Franklin's call.";
    }
    return "Tier match.";
  }
  if (d.bucket === "BOTH_DIFFER") {
    const ours = d.ours;
    const theirs = d.theirs;
    if (!theirs) return "Franklin's classification couldn't be mapped onto our tier vocabulary.";
    if ((ours === "P" || ours === "LP") && (theirs === "B" || theirs === "LB")) {
      return "We call pathogenic; Franklin calls benign. Strongest disagreement — inspect ACMG fired criteria.";
    }
    if ((theirs === "P" || theirs === "LP") && (ours === "B" || ours === "LB")) {
      return "Franklin calls pathogenic; we call benign. May be a missing ACMG criterion or an Indian-cohort AF override.";
    }
    if (ours === "VUS" && (theirs === "P" || theirs === "LP")) {
      return "Franklin graduates this past VUS; we don't. Likely a missing PS3/PM3/PP1/PP4 criterion on our side.";
    }
    if (theirs === "VUS" && (ours === "P" || ours === "LP")) {
      return "We call pathogenic; Franklin keeps as VUS. Could be over-counted points — review the fired criteria.";
    }
    return `One-tier offset (${ours} vs ${theirs}).`;
  }
  if (d.bucket === "FRANKLIN_ONLY") {
    // Why might we have filtered it? Population AF is the most common cause.
    const af = d.f?.aggregated_af;
    if (af != null && af > 0.01) {
      return `Franklin keeps this; we filtered as common (AF ${af.toExponential(2)} > 1%).`;
    }
    return "Not in our candidate set. Could be: filtered by proband-carrier rule, dropped at site/genotype QC, or below our consequence-severity threshold.";
  }
  if (d.bucket === "VARIANTGPT_ONLY") {
    return "Not in Franklin's export. Franklin's default filter set is stricter on AF — they may have dropped it as common.";
  }
  return "";
}
