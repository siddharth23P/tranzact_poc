'use strict';

// Delivery: the client-facing manifest payload (per-file presigned URLs +
// hashes for client-side assembly). Shared by GET /jobs/:id/manifest,
// POST /jobs/:id/manifest/refresh, and the zip's embedded MANIFEST.json.

const config = require('./config');
const manifest = require('./manifest');
const progress = require('./progress');
const s3 = require('./s3');

const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed']);

function isTerminal(status) {
  return TERMINAL.has(status);
}

// The ledger is append-only, so a document that was retried can have several
// rows; the LATEST row per document_index is the authoritative outcome.
function latestPerDocument(entries) {
  const byIndex = new Map();
  for (const entry of entries) byIndex.set(entry.document_index, entry); // ordered by (index, id)
  return [...byIndex.values()].sort((a, b) => a.document_index - b.document_index);
}

// Build the manifest payload. `withUrls: false` produces the zip-embedded
// variant (hashes + errors, no presigned URLs — URLs would expire inside a
// cached zip).
async function buildManifestPayload(job, { withUrls = true } = {}) {
  const entries = latestPerDocument(await manifest.listForJob(job.id));

  // Counts: live Redis while rendering, flushed jobs row at terminal.
  let completed = job.completed_documents;
  let failed = job.failed_documents;
  if (!isTerminal(job.status)) {
    const live = await progress.readLive(job.id).catch(() => null);
    if (live) ({ completed, failed } = live);
  }

  // Snapshot timestamp comes from the stored object itself.
  let snapshotCreatedAt = null;
  try {
    const head = await s3.headObject(job.snapshot_key);
    snapshotCreatedAt = head.LastModified ? new Date(head.LastModified).toISOString() : null;
  } catch (_) {
    /* snapshot missing (shouldn't happen) — leave null */
  }

  const expirySeconds = config.render.presignExpirySeconds;
  const urlsExpireAt = withUrls ? new Date(Date.now() + expirySeconds * 1000).toISOString() : undefined;

  const documents = [];
  for (const entry of entries) {
    if (entry.status === 'rendered') {
      documents.push({
        index: entry.document_index,
        documentId: entry.document_id,
        status: 'rendered',
        sha256: entry.sha256,
        byteSize: Number(entry.byte_size),
        renderStrategy: entry.render_strategy,
        renderedAt: entry.created_at, // manifest-row timestamp (ledger truth)
        ...(withUrls ? { url: await s3.presignGet(entry.artifact_key, expirySeconds) } : {}),
      });
    } else {
      documents.push({
        index: entry.document_index,
        documentId: entry.document_id,
        status: 'error',
        error: entry.error_message,
      });
    }
  }

  return {
    jobId: job.id,
    status: job.status,
    priority: job.priority,
    counts: {
      total: job.total_documents,
      rendered: completed,
      failed,
    },
    snapshot: { key: job.snapshot_key, createdAt: snapshotCreatedAt },
    ...(withUrls ? { urlExpirySeconds: expirySeconds, urlsExpireAt } : {}),
    documents,
  };
}

module.exports = { buildManifestPayload, isTerminal, latestPerDocument };
