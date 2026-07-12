'use strict';

// Jobs repository — all reads/writes via the app pool (pdf_app).

const db = require('./db');

// Insert a new job row. If an idempotency key is supplied and already exists,
// no new row is created and the existing job is returned with created=false.
// Concurrency-safe via ON CONFLICT on the unique idempotency_key.
async function insertJob({ id, idempotencyKey, priority, totalDocuments, snapshotKey }) {
  if (idempotencyKey) {
    const { rows } = await db.appPool.query(
      `INSERT INTO jobs (id, idempotency_key, status, priority, total_documents, snapshot_key)
       VALUES ($1, $2, 'queued', $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, idempotencyKey, priority, totalDocuments, snapshotKey]
    );
    if (rows.length > 0) return { job: rows[0], created: true };

    // Conflict: a job with this key already exists — return it.
    const existing = await db.appPool.query('SELECT * FROM jobs WHERE idempotency_key = $1', [
      idempotencyKey,
    ]);
    return { job: existing.rows[0], created: false };
  }

  const { rows } = await db.appPool.query(
    `INSERT INTO jobs (id, status, priority, total_documents, snapshot_key)
     VALUES ($1, 'queued', $2, $3, $4)
     RETURNING *`,
    [id, priority, totalDocuments, snapshotKey]
  );
  return { job: rows[0], created: true };
}

async function setStatus(id, status, errorMessage) {
  const { rows } = await db.appPool.query(
    `UPDATE jobs SET status = $2, error_message = $3, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, errorMessage ?? null]
  );
  return rows[0];
}

async function getById(id) {
  const { rows } = await db.appPool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { insertJob, setStatus, getById };
