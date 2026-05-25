-- Jobs + uploads tracking for the Workers API.
--
-- The dev middleware (app/web/vite.devCaseApi.ts) kept all of this in memory
-- + a status.json sidecar; in production the Worker is stateless so it lives
-- in D1. The container POSTs status updates back to the Worker which writes
-- here; the SPA polls /api/cases/:id/status which reads from here.

CREATE TABLE IF NOT EXISTS jobs (
    case_id      TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued|running|ready|error
    started_at   INTEGER,                          -- epoch ms
    finished_at  INTEGER,                          -- epoch ms
    error        TEXT,
    log_json     TEXT NOT NULL DEFAULT '[]',       -- last ~50 log lines
    manifest_json TEXT                              -- last submitted manifest
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- One row per uploaded VCF/BAM blob in R2. The Worker creates the row when
-- it presigns the PUT; the SPA can list completions before kicking off /run.
CREATE TABLE IF NOT EXISTS uploads (
    case_id      TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,                    -- proband|father|mother|...
    r2_key       TEXT NOT NULL,
    filename     TEXT,                              -- original client filename
    size_bytes   INTEGER,
    uploaded_at  INTEGER NOT NULL,                  -- epoch ms
    PRIMARY KEY (case_id, role)
);
