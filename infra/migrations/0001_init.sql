-- VariantGPT initial schema (PRD §6.5).
-- D1 holds case metadata, candidate variants, evidence, decisions, and the
-- append-only audit log. Raw VCFs and bulk genotype data live in R2.

CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    build TEXT,                       -- 'GRCh37' | 'GRCh38'
    status TEXT NOT NULL DEFAULT 'draft',  -- draft|queued|running|ready|signed|error
    signed_by TEXT,
    signed_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    role TEXT NOT NULL,               -- proband|father|mother|sibling|relative
    sex TEXT NOT NULL,                -- male|female|unknown
    affected TEXT NOT NULL,           -- affected|unaffected|unknown
    vcf_r2_key TEXT,
    sample_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_case ON members(case_id);

CREATE TABLE IF NOT EXISTS hpo_terms (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    hpo_id TEXT NOT NULL,
    label TEXT,
    source TEXT NOT NULL DEFAULT 'manual' -- manual | llm_confirmed
);
CREATE INDEX IF NOT EXISTS idx_hpo_case ON hpo_terms(case_id);

CREATE TABLE IF NOT EXISTS clinical_history (
    case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    onset_age TEXT,
    consanguinity INTEGER NOT NULL DEFAULT 0,
    prior_testing TEXT
);

CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    chrom TEXT NOT NULL,
    pos INTEGER NOT NULL,
    ref TEXT NOT NULL,
    alt TEXT NOT NULL,
    gene TEXT,
    transcript TEXT,
    hgvs_c TEXT,
    hgvs_p TEXT,
    consequence TEXT,
    inheritance_models_json TEXT NOT NULL DEFAULT '[]',
    baseline_tier TEXT,
    baseline_points INTEGER NOT NULL DEFAULT 0,
    reclass_tier TEXT,
    reclass_points INTEGER,
    reclass_delta INTEGER,
    priority_score REAL NOT NULL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_variants_case ON variants(case_id);
CREATE INDEX IF NOT EXISTS idx_variants_priority ON variants(case_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_variants_tier ON variants(case_id, baseline_tier);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    criterion TEXT NOT NULL,          -- PVS1, PS2, PM2, BA1, ...
    fired INTEGER NOT NULL,
    strength TEXT,                    -- VS|S|M|P|BS|BP|BA
    points INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_variant ON evidence(variant_id);

CREATE TABLE IF NOT EXISTS populations (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    source TEXT NOT NULL,             -- gnomad_v4_global|gnomad_v4_sas|indigenomes|genomeasia|genomeindia
    ac INTEGER,
    an INTEGER,
    af REAL,
    n_hom INTEGER,
    n_het INTEGER
);
CREATE INDEX IF NOT EXISTS idx_populations_variant ON populations(variant_id);

CREATE TABLE IF NOT EXISTS predictors (
    variant_id TEXT PRIMARY KEY REFERENCES variants(id) ON DELETE CASCADE,
    alphamissense REAL,
    revel REAL,
    cadd REAL,
    spliceai REAL,
    phylop REAL,
    gerp REAL
);

CREATE TABLE IF NOT EXISTS reclass_proposals (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    from_tier TEXT NOT NULL,
    to_tier TEXT NOT NULL,
    changed_criteria_json TEXT NOT NULL,
    af_evidence_json TEXT NOT NULL,
    snapshot_versions_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|modified
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposals_variant ON reclass_proposals(variant_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON reclass_proposals(status);

-- Append-only. No UPDATE / DELETE allowed in code paths.
CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL REFERENCES reclass_proposals(id),
    curator TEXT NOT NULL,
    action TEXT NOT NULL,             -- accept|reject|modify
    note TEXT,
    decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_proposal ON decisions(proposal_id);

-- Append-only audit log of all curator actions and report signings.
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id, at DESC);
