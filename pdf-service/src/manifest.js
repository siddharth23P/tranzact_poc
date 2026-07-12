'use strict';

// Runtime manifest writes. Every insert goes through the restricted
// `manifest_writer` pool (db.getManifestPool), NOT the app or owner role.
// Because that role has no UPDATE/DELETE grant, the append-only property is
// enforced by Postgres, not by this code being careful.

const db = require('./db');

// Append a rendered-artifact entry to the ledger.
async function appendRendered({ jobId, documentIndex, documentId, artifactKey, sha256, byteSize }) {
  const pool = db.getManifestPool();
  const { rows } = await pool.query(
    `INSERT INTO manifest_entries
       (job_id, document_index, document_id, status, artifact_key, sha256, byte_size)
     VALUES ($1, $2, $3, 'rendered', $4, $5, $6)
     RETURNING id, created_at`,
    [jobId, documentIndex, documentId ?? null, artifactKey, sha256, byteSize ?? null]
  );
  return rows[0];
}

// Append a per-document error entry (partial-failure path).
async function appendError({ jobId, documentIndex, documentId, errorMessage }) {
  const pool = db.getManifestPool();
  const { rows } = await pool.query(
    `INSERT INTO manifest_entries
       (job_id, document_index, document_id, status, error_message)
     VALUES ($1, $2, $3, 'error', $4)
     RETURNING id, created_at`,
    [jobId, documentIndex, documentId ?? null, errorMessage]
  );
  return rows[0];
}

// Read all ledger entries for a job (via the same restricted pool, which has
// SELECT). Ordered by document position then insertion order.
async function listForJob(jobId) {
  const pool = db.getManifestPool();
  const { rows } = await pool.query(
    `SELECT id, document_index, document_id, status, artifact_key, sha256,
            byte_size, error_message, created_at
       FROM manifest_entries
      WHERE job_id = $1
      ORDER BY document_index, id`,
    [jobId]
  );
  return rows;
}

module.exports = { appendRendered, appendError, listForJob };
