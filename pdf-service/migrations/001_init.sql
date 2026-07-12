-- Phase 1 schema: jobs + append-only manifest.
-- The restricted manifest_writer role and its grants are applied by the
-- migration runner (src/migrate.js) so the role password stays out of VCS.

-- ---------------------------------------------------------------------------
-- jobs: mutable job/aggregate state. Progress counters live here (also mirrored
-- in Redis for hot polling); status transitions as the job is processed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id                  UUID PRIMARY KEY,
    idempotency_key     TEXT UNIQUE,
    status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','queued','processing','completed','failed')),
    priority            TEXT NOT NULL DEFAULT 'single'
                          CHECK (priority IN ('single','bulk')),
    snapshot_key        TEXT,                 -- s3 key: snapshots/{jobId}.json
    total_documents     INTEGER NOT NULL DEFAULT 0,
    completed_documents INTEGER NOT NULL DEFAULT 0,
    failed_documents    INTEGER NOT NULL DEFAULT 0,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at);

-- ---------------------------------------------------------------------------
-- manifest_entries: append-only, tamper-evident ledger. One row per rendered
-- artifact (or per-document error). Never UPDATEd or DELETEd — corrections are
-- new rows. The append-only guarantee is enforced by DB grants on the
-- manifest_writer role (see src/migrate.js), not by app convention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manifest_entries (
    id              BIGSERIAL PRIMARY KEY,
    job_id          UUID NOT NULL REFERENCES jobs (id),
    document_index  INTEGER NOT NULL,          -- position within the job
    document_id     TEXT,                       -- source ERP entity id, if any
    status          TEXT NOT NULL
                      CHECK (status IN ('rendered','error')),
    artifact_key    TEXT,                       -- s3 key of the pdf (rendered)
    sha256          TEXT,                       -- hex digest of artifact bytes
    byte_size       BIGINT,
    error_message   TEXT,                       -- populated when status='error'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manifest_job_idx ON manifest_entries (job_id);
CREATE INDEX IF NOT EXISTS manifest_job_doc_idx ON manifest_entries (job_id, document_index);
