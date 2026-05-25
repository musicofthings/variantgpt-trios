import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../apiBase";

export type RunStatus = "queued" | "running" | "ready" | "error" | "unknown";

export interface JobStatus {
  status: RunStatus;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  manifest?: { fileCount?: number; memberCount?: number; missingCount?: number };
  log: string[];
}

/** Fetches /api/cases/:id/status on an interval until terminal, returning
 * the latest job snapshot + a derived "polling done" flag. */
export function useJobStatus(caseId: string | undefined, intervalMs = 1000): JobStatus | null {
  const [status, setStatus] = useState<JobStatus | null>(null);

  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const r = await fetch(api(`/cases/${caseId}/status`));
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j = (await r.json()) as JobStatus;
        if (cancelled) return;
        setStatus(j);
        if (j.status !== "ready" && j.status !== "error") {
          timer = setTimeout(tick, intervalMs);
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, intervalMs * 2);
      }
    }
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [caseId, intervalMs]);

  return status;
}

/** Big visible run-status card. Used inline on Intake (during run) and as the
 * Workbench placeholder when the case.json doesn't exist yet. */
export function RunMonitor({
  caseId,
  status,
  showOpenLink = true,
}: { caseId: string; status: JobStatus | null; showOpenLink?: boolean }) {
  const s = status?.status ?? "queued";
  const elapsed = status?.elapsedMs ?? 0;
  const tier = TIER[s];

  return (
    <section className="run-monitor card" aria-live="polite">
      <header className="run-monitor-head">
        <div>
          <div className="run-monitor-eyebrow">Engine run</div>
          <h3 className="mono" style={{ fontFamily: "var(--font-mono)" }}>{caseId}</h3>
        </div>
        <span className={`run-pill run-pill-${s}`}>{tier.label}</span>
      </header>

      <div className="run-progress" aria-hidden>
        <div className={`run-progress-bar run-progress-${s}`} />
      </div>

      <dl className="run-meta">
        <div><dt>Elapsed</dt><dd className="mono">{fmtMs(elapsed)}</dd></div>
        {status?.manifest?.memberCount != null ? (
          <div>
            <dt>Members</dt>
            <dd className="mono">
              {status.manifest.memberCount}
              {status.manifest.missingCount ? ` (${status.manifest.missingCount} no sample)` : ""}
            </dd>
          </div>
        ) : null}
        {status?.manifest?.fileCount != null ? (
          <div><dt>VCFs</dt><dd className="mono">{status.manifest.fileCount}</dd></div>
        ) : null}
      </dl>

      {status?.error ? (
        <div className="run-error" role="alert">
          <strong>Engine error:</strong> {status.error}
        </div>
      ) : null}

      <details open className="run-log">
        <summary>Engine log ({status?.log?.length ?? 0} lines)</summary>
        <pre className="mono">
          {status?.log?.length
            ? status.log.join("\n")
            : "Waiting for engine output…"}
        </pre>
      </details>

      {s === "ready" && showOpenLink ? (
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <Link to={`/cases/${caseId}`}><button className="primary">Open workbench</button></Link>
        </div>
      ) : null}
    </section>
  );
}

const TIER: Record<RunStatus, { label: string }> = {
  queued:  { label: "Queued" },
  running: { label: "Running" },
  ready:   { label: "Ready" },
  error:   { label: "Error" },
  unknown: { label: "Unknown" },
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}
