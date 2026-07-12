-- Phase 4: a bulk job that finishes with some per-document failures must NOT
-- report a plain 'completed'. Add 'completed_with_errors' as a distinct terminal
-- state. The rendered/failed counts already live on the job row
-- (completed_documents / failed_documents).

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check
  CHECK (status IN (
    'pending',
    'queued',
    'processing',
    'completed',
    'completed_with_errors',
    'failed'
  ));
