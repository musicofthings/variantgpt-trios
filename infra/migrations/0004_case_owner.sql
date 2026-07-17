-- Per-user ownership for cases (tenant isolation).
--
-- Before this migration the API authenticated requests (Clerk JWT) but never
-- authorized them: any signed-in user could read or mutate any case by id.
-- owner_id is the Clerk `sub` of whoever first created the case row; every
-- case-scoped read/write is now gated on it in the Worker.
--
-- Nullable so pre-existing rows don't break. Legacy NULL-owner rows are claimed
-- by the first authenticated caller that touches them (see caseAccessGate in
-- app/api/src/routes/api.ts). In dev mode (CLERK_ISSUER unset) every request
-- runs as the synthetic user 'dev-unauthenticated', so the app stays effectively
-- single-tenant.
ALTER TABLE cases ADD COLUMN owner_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cases_owner ON cases(owner_id);
