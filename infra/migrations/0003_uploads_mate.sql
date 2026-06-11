-- Support paired-end FASTQ: two uploads (R1 + R2) per role.
--
-- The uploads PK was (case_id, role) — one blob per member. Paired FASTQ needs
-- two (R1/R2), so add a `mate` discriminator and widen the PK. VCF/BAM uploads
-- keep mate='' (single blob per role, unchanged).
--
-- SQLite can't ALTER a primary key in place, so recreate the table.

CREATE TABLE IF NOT EXISTS uploads_new (
    case_id      TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    role         TEXT NOT NULL,
    mate         TEXT NOT NULL DEFAULT '',          -- '' for VCF/BAM, 'R1'/'R2' for FASTQ
    r2_key       TEXT NOT NULL,
    filename     TEXT,
    size_bytes   INTEGER,
    uploaded_at  INTEGER NOT NULL,
    PRIMARY KEY (case_id, role, mate)
);

INSERT INTO uploads_new (case_id, role, mate, r2_key, filename, size_bytes, uploaded_at)
    SELECT case_id, role, '', r2_key, filename, size_bytes, uploaded_at FROM uploads;

DROP TABLE uploads;
ALTER TABLE uploads_new RENAME TO uploads;
