import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchLibrarySamples, humanBytes, setDataSelection, type LibrarySample } from "../data";

/** Data section — browse the partner-lab samples synced from SFTP into R2
 *  (data/incoming/, refreshed daily). Tick samples and "New case" carries them
 *  straight into the pipeline (server-side; no download/upload). */
export function DataLibrary() {
  const [samples, setSamples] = useState<LibrarySample[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // sample paths
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      fetchLibrarySamples(q.trim() || undefined)
        .then((s) => { if (!cancelled) { setSamples(s); setError(null); } })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250); // debounce search
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const paired = samples.filter((s) => s.paired).length;
  const usable = samples.filter((s) => s.r1 || s.vcf);
  const allSelected = usable.length > 0 && usable.every((s) => selected.has(s.path));

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(usable.map((s) => s.path)));
  }
  function startCase() {
    // Preserve the visible order of the selected samples (proband first).
    const ordered = samples.filter((s) => selected.has(s.path)).map((s) => s.path);
    setDataSelection(ordered);
    navigate("/cases/new"); // pipeline picker → Intake pre-fills these
  }

  return (
    <>
      <div className="topbar">
        <h1>Data library</h1>
        <span className="pill">{samples.length} samples</span>
        {paired > 0 ? <span className="pill">{paired} paired</span> : null}
        {selected.size > 0 ? <span className="pill" style={{ color: "var(--primary)" }}>{selected.size} selected</span> : null}
        <button
          className="primary"
          style={{ marginLeft: "auto" }}
          disabled={selected.size === 0}
          title={selected.size === 0 ? "Tick one or more samples first" : "Start a case with the selected samples"}
          onClick={startCase}
        >
          New case from {selected.size || ""} sample{selected.size === 1 ? "" : "s"} →
        </button>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 10px", lineHeight: 1.6 }}>
          Samples are synced daily from the partner lab's SFTP server into object storage
          (one folder per sample). Pick a pipeline under <strong>New case</strong> and assign
          these samples to roles — the engine reads them directly, with no download or re-upload.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search samples by name…"
          style={{ width: "100%", maxWidth: 420, padding: "8px 10px" }}
          aria-label="Search samples"
        />
      </section>

      {error ? (
        <div className="card" style={{ color: "var(--rust, #b04a2a)" }}>
          Couldn't load the data library: {error}
        </div>
      ) : loading && samples.length === 0 ? (
        <div className="card">Loading samples…</div>
      ) : samples.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>
            No samples found{q ? ` matching “${q}”` : ""}. Once the daily SFTP sync runs,
            partner-lab samples appear here automatically.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table" style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ width: 32, textAlign: "center" }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th style={{ textAlign: "left" }}>Sample (patient)</th>
                <th style={{ width: 130 }}>Available</th>
                <th style={{ width: 70 }}>Files</th>
                <th style={{ width: 110 }}>Total size</th>
                <th style={{ textAlign: "left" }}>Filenames</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => {
                const total = s.files.reduce((n, f) => n + (f.size || 0), 0);
                const selectable = !!(s.r1 || s.vcf);
                return (
                  <tr key={s.path} style={{ background: selected.has(s.path) ? "var(--primary-soft)" : undefined }}>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(s.path)}
                        disabled={!selectable}
                        onChange={() => toggle(s.path)}
                        aria-label={`Select ${s.sample}`}
                      />
                    </td>
                    <td className="mono">
                      <strong>{s.sample}</strong>
                      {s.path !== s.sample ? (
                        <div style={{ fontSize: 10, color: "var(--ink-soft)" }}>{s.path.replace(/\/[^/]*$/, "") || "—"}</div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span style={{ display: "inline-flex", gap: 4, justifyContent: "center" }}>
                        {s.vcf ? <span className="pill" style={{ fontSize: 10, color: "var(--primary)" }}>VCF</span> : null}
                        {s.paired
                          ? <span className="pill" style={{ fontSize: 10, color: "var(--success, #2c8462)" }}>FASTQ R1+R2</span>
                          : s.r1
                          ? <span className="pill" style={{ fontSize: 10, color: "var(--ink-soft)" }}>R1 only</span>
                          : null}
                        {!s.vcf && !s.r1 ? <span style={{ color: "var(--rust, #b04a2a)", fontSize: 11 }}>none</span> : null}
                      </span>
                    </td>
                    <td style={{ textAlign: "center" }}>{s.files.length}</td>
                    <td className="mono">{humanBytes(total)}</td>
                    <td className="mono" style={{ color: "var(--ink-soft)", fontSize: 11 }}>
                      {s.files.map((f) => f.name).join("  ·  ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
