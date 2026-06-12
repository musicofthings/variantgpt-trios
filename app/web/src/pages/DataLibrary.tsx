import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchLibrarySamples, humanBytes, type LibrarySample } from "../data";

/** Data section — browse the partner-lab samples synced from SFTP into R2
 *  (data/incoming/, one folder per sample, refreshed daily). From here a sample
 *  can be sent straight into a new case (server-side; no download/upload). */
export function DataLibrary() {
  const [samples, setSamples] = useState<LibrarySample[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <div className="topbar">
        <h1>Data library</h1>
        <span className="pill">{samples.length} samples</span>
        {paired > 0 ? <span className="pill">{paired} paired</span> : null}
        <Link to="/cases/new" style={{ marginLeft: "auto" }}><button className="primary">New case from data →</button></Link>
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
                <th style={{ textAlign: "left" }}>Sample</th>
                <th style={{ width: 90 }}>Reads</th>
                <th style={{ width: 90 }}>Files</th>
                <th style={{ width: 110 }}>Total size</th>
                <th style={{ textAlign: "left" }}>Files</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s) => {
                const total = s.files.reduce((n, f) => n + (f.size || 0), 0);
                return (
                  <tr key={s.sample}>
                    <td className="mono"><strong>{s.sample}</strong></td>
                    <td style={{ textAlign: "center" }}>
                      {s.paired
                        ? <span style={{ color: "var(--success, #2c8462)" }}>R1 + R2</span>
                        : s.r1
                        ? <span style={{ color: "var(--ink-soft)" }}>R1 only</span>
                        : <span style={{ color: "var(--rust, #b04a2a)" }}>unpaired</span>}
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
