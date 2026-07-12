'use strict';

// Jobs repository — all reads/writes via the app pool (pdf_app).

const db = require('./db');

// Status lifecycle:
//   pending    -> row exists, NOT yet snapshotted/enqueued (unique-key gate)
//   queued     -> snapshot written AND all tasks enqueued (set last)
//   processing -> a worker has started at least one task
//   completed  -> terminal (flushed from Redis counters)
//   failed     -> terminal error (snapshot/enqueue failed, or all docs errored)
//
// The route sets 'queued' only AFTER enqueue succeeds, so there is never a
// window where status='queued' but tasks are missing. A worker (phase 3) only
// renders tasks whose job is in {queued, processing}; a 'pending'/'failed' job
// never produces artifacts even if a task leaked into the queue — which is what
// makes enqueue all-or-nothing *from the job's perspective*.

const UNIQUE_VIOLATION = '23505';

// Insert a new job row in 'pending'. If an idempotency key is supplied and
// already exists, no new row is created and the existing job is returned with
// created=false. Concurrency-safe: the unique idempotency_key is the gate, and
// we handle both the ON CONFLICT path and a raw 23505 (belt and suspenders) so
// the racing loser always gets the existing job back — never a 500.
async function insertJob({ id, idempotencyKey, priority, totalDocuments, snapshotKey }) {
  if (!idempotencyKey) {
    const { rows } = await db.appPool.query(
      `INSERT INTO jobs (id, status, priority, total_documents, snapshot_key)
       VALUES ($1, 'pending', $2, $3, $4)
       RETURNING *`,
      [id, priority, totalDocuments, snapshotKey]
    );
    return { job: rows[0], created: true };
  }

  try {
    const { rows } = await db.appPool.query(
      `INSERT INTO jobs (id, idempotency_key, status, priority, total_documents, snapshot_key)
       VALUES ($1, $2, 'pending', $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, idempotencyKey, priority, totalDocuments, snapshotKey]
    );
    if (rows.length > 0) return { job: rows[0], created: true };

    // ON CONFLICT swallowed the insert — a job with this key already exists.
    // (ON CONFLICT waits for a concurrent inserter to commit, so by here the
    // winner's row is visible.)
    return { job: await getByIdempotencyKey(idempotencyKey), created: false };
  } catch (err) {
    // Defensive: if the conflict ever surfaces as a raw unique violation
    // (e.g. a different conflict path), treat it as an idempotent replay.
    if (err.code === UNIQUE_VIOLATION) {
      return { job: await getByIdempotencyKey(idempotencyKey), created: false };
    }
    throw err;
  }
}

async function getByIdempotencyKey(idempotencyKey) {
  const { rows } = await db.appPool.query('SELECT * FROM jobs WHERE idempotency_key = $1', [
    idempotencyKey,
  ]);
  return rows[0] || null;
}

async function setStatus(id, status, errorMessage) {
  const { rows } = await db.appPool.query(
    `UPDATE jobs SET status = $2, error_message = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, errorMessage ?? null]
  );
  return rows[0];
}

// Flip queued -> processing on first task pickup (idempotent, race-safe).
async function markProcessing(id) {
  await db.appPool.query(
    `UPDATE jobs SET status='processing', updated_at=now()
      WHERE id=$1 AND status='queued'`,
    [id]
  );
}

async function getById(id) {
  const { rows } = await db.appPool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { insertJob, setStatus, markProcessing, getById, getByIdempotencyKey };
