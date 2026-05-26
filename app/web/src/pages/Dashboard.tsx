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
  /** True when this case exists in R2 but its D1 row was wiped. */
  orphan?: boolean;
}

export function Dashboard() {
  const { data: demo } = useDemoCase();
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);   // caseId or "cleanup"
  const [notice, setNotice] = useState<string | null>(null);

  async function deleteCase(caseId: string, hint: string) {
    if (!confirm(`Delete ${hint}?\n\nThis removes the R2 uploads, case.json, and all database rows.\nThis cannot be undone.`)) return;
    setBusy(caseId); setError(null); setNotice(null);
    try {
      const r = await fetch(api(`/cases/${caseId}`), { method: "DELETE" });
      const j: { ok?: boolean; r2Purged?: number; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setNotice(`Deleted ${caseId} (${j.r2Purged ?? 0} R2 objects).`);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function recoverCase(caseId: string) {
    if (!confirm(`Recover ${caseId}?\n\nRebuilds the database rows from the R2 uploads. After recovery you'll need to re-open the case and re-enter the pedigree + click Run.`)) return;
    setBusy(caseId); setError(null); setNotice(null);
    try {
      const r = await fetch(api(`/cases/${caseId}/recover`), { method: "POST" });
      const j: { ok?: boolean; role_count?: number; files?: string[]; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setNotice(`Recovered ${caseId}: ${j.role_count} files (${(j.files ?? []).join(", ")}). Open the case and click Run to start analysis.`);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(`Recover failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function rerunCase(caseId: string) {
    if (!confirm(`Re-run analysis on ${caseId}?\nUses the same uploads from the previous run — no re-upload needed.`)) return;
    setBusy(caseId); setError(null); setNotice(null);
    try {
      const r = await fetch(api(`/cases/${caseId}/rerun`), { method: "POST" });
      const j: { ok?: boolean; status?: string; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `status ${r.status}`);
      setNotice(`Re-running ${caseId}…`);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(`Re-run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function cleanupOrphaned() {
    if (!confirm("Sweep failed runs and orphaned runs (running >30 min)?\nThis deletes their R2 uploads and DB rows.")) return;
    setBusy("cleanup"); setError(null); setNotice(null);
    try {
      const r = await fetch(api(`/cases/cleanup`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ olderThanMinutes: 30 }),
      });
      const j: { deleted?: string[]; r2Purged?: number; error?: string } = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `status ${r.status}`);
      const n = j.deleted?.length ?? 0;
      setNotice(n === 0 ? "Nothing to clean up." : `Cleaned ${n} case${n === 1 ? "" : "s"} (${j.r2Purged ?? 0} R2 objects).`);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setError(`Cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

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
        <button onClick={() => setRefreshTick((t) => t + 1)} title="Refresh list" disabled={!!busy}>↻</button>
        <button
          onClick={cleanupOrphaned}
          disabled={!!busy}
          title="Delete failed + orphaned runs (running >30 min). Frees R2 storage."
        >
          {busy === "cleanup" ? "Cleaning…" : "Clean up failed/orphaned"}
        </button>
        <Link to="/cases/new"><button className="primary">New case</button></Link>
      </div>

      {error ? (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>{error}</div>
      ) : null}
      {notice ? (
        <div className="banner" style={{ marginBottom: 16, background: "var(--paper-soft, #f6f1e6)", padding: 12, borderRadius: 6 }}>
          {notice}
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
                    <td style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Link to={`/cases/${c.caseId}`}>View progress →</Link>
                      <button
                        onClick={() => rerunCase(c.caseId)}
                        disabled={busy === c.caseId}
                        title="Re-run engine on existing uploads (resets the stuck run)"
                      >
                        {busy === c.caseId ? "…" : "Re-run"}
                      </button>
                      <button
                        onClick={() => deleteCase(c.caseId, c.caseId)}
                        disabled={busy === c.caseId}
                        title="Delete this run + its uploads"
                        aria-label={`Delete ${c.caseId}`}
                        style={{ color: "var(--rust, #b04a2a)" }}
                      >
                        {busy === c.caseId ? "…" : "Delete"}
                      </button>
                    </td>
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {/* Demo case is always first if loaded. Not deletable — it's
                  bundled with the SPA, not stored in R2/D1. */}
              {demo ? (
                <tr>
                  <td><Link to={`/cases/${demo.caseRow.id}`}>{demo.caseRow.name}</Link></td>
                  <td><RunStatusPill status="ready" label="demo · ready" /></td>
                  <td className="num">3</td>
                  <td className="num">3</td>
                  <td>{demo.caseRow.updated_at}</td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 11 }}>bundled</td>
                </tr>
              ) : null}
              {history.map((c) => (
                <tr key={c.caseId} style={c.orphan ? { background: "var(--paper-soft, #f6f1e6)" } : undefined}>
                  <td>
                    <Link to={`/cases/${c.caseId}`} className="mono">{c.caseId}</Link>
                    {c.orphan ? (
                      <span title="VCFs still in R2 but database row is gone — Recover rebuilds the DB rows from R2"
                            style={{ marginLeft: 8, fontSize: 11, color: "var(--rust, #b04a2a)" }}>
                        orphan
                      </span>
                    ) : null}
                  </td>
                  <td><RunStatusPill status={c.status} /></td>
                  <td className="num">{c.memberCount ?? "—"}</td>
                  <td className="num">{c.fileCount ?? "—"}</td>
                  <td>{c.finishedAt ? fmtTime(c.finishedAt) : c.hasResult ? "—" : "—"}</td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {c.orphan ? (
                      <button
                        onClick={() => recoverCase(c.caseId)}
                        disabled={busy === c.caseId}
                        title="Rebuild DB rows from R2 uploads"
                      >
                        {busy === c.caseId ? "…" : "Recover"}
                      </button>
                    ) : (
                      <button
                        onClick={() => rerunCase(c.caseId)}
                        disabled={busy === c.caseId}
                        title="Re-run engine on existing uploads (works even if status is stuck on running)"
                      >
                        {busy === c.caseId ? "…" : "Re-run"}
                      </button>
                    )}
                    <button
                      onClick={() => deleteCase(c.caseId, c.caseId)}
                      disabled={busy === c.caseId}
                      title="Delete case + uploads"
                      aria-label={`Delete ${c.caseId}`}
                      style={{ color: "var(--rust, #b04a2a)" }}
                    >
                      {busy === c.caseId ? "…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {!demo && history.length === 0 && active.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--ink-soft)", padding: 24 }}>
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
