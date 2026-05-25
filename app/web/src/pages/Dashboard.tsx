import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDemoCase } from "../caseData";
import { api } from "../apiBase";

interface CaseListItem {
  caseId: string;
  status: "queued" | "running" | "ready" | "error" | "unknown";
  startedAt?: number;
  finishedAt?: number;
  fileCount?: number;
  memberCount?: number;
  missingCount?: number;
  error?: string;
  hasResult: boolean;
}

export function Dashboard() {
  const { data: demo } = useDemoCase();
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Initial load + auto-refresh while any case is queued/running.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const r = await fetch(api("/cases"));
        if (!r.ok) throw new Error(`/api/cases ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        const list: CaseListItem[] = j.cases ?? [];
        setCases(list);
        if (list.some((c) => c.status === "queued" || c.status === "running")) {
          timer = setTimeout(() => setRefreshTick((t) => t + 1), 1500);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [refreshTick]);

  const active = cases.filter((c) => c.status === "queued" || c.status === "running");
  const history = cases.filter((c) => c.status !== "queued" && c.status !== "running");

  return (
    <>
      <div className="topbar">
        <h1>Cases</h1>
        <button onClick={() => setRefreshTick((t) => t + 1)} title="Refresh list">↻</button>
        <Link to="/cases/new"><button className="primary">New case</button></Link>
      </div>

      {error ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          Could not load case list: {error}
        </div>
      ) : null}

      {active.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Active runs ({active.length})
          </h3>
          <div className="card" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Status</th>
                  <th className="num">Members</th>
                  <th className="num">VCFs</th>
                  <th>Started</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {active.map((c) => (
                  <tr key={c.caseId}>
                    <td><Link to={`/cases/${c.caseId}`} className="mono">{c.caseId}</Link></td>
                    <td><RunStatusPill status={c.status} /></td>
                    <td className="num">{c.memberCount ?? "—"}</td>
                    <td className="num">{c.fileCount ?? "—"}</td>
                    <td>{c.startedAt ? fmtTime(c.startedAt) : "—"}</td>
                    <td><Link to={`/cases/${c.caseId}`}>View progress →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section>
        <h3 style={{ fontSize: 14, marginBottom: 8, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          History
        </h3>
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th className="num">Members</th>
                <th className="num">VCFs</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {/* Demo case is always first if loaded */}
              {demo ? (
                <tr>
                  <td><Link to={`/cases/${demo.caseRow.id}`}>{demo.caseRow.name}</Link></td>
                  <td><RunStatusPill status="ready" label="demo · ready" /></td>
                  <td className="num">3</td>
                  <td className="num">3</td>
                  <td>{demo.caseRow.updated_at}</td>
                </tr>
              ) : null}
              {history.map((c) => (
                <tr key={c.caseId}>
                  <td><Link to={`/cases/${c.caseId}`} className="mono">{c.caseId}</Link></td>
                  <td><RunStatusPill status={c.status} /></td>
                  <td className="num">{c.memberCount ?? "—"}</td>
                  <td className="num">{c.fileCount ?? "—"}</td>
                  <td>{c.finishedAt ? fmtTime(c.finishedAt) : c.hasResult ? "—" : "—"}</td>
                </tr>
              ))}
              {!demo && history.length === 0 && active.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "var(--ink-soft)", padding: 24 }}>
                    No cases yet. <Link to="/cases/new">Create one</Link>.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function RunStatusPill({ status, label }: { status: CaseListItem["status"]; label?: string }) {
  return <span className={`run-pill run-pill-${status}`} style={{ fontSize: 11, padding: "2px 8px" }}>{label ?? status}</span>;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}
