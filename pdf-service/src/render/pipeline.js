'use strict';

// The per-document render pipeline, shared by the worker and the smoke test:
//   acquire page -> render (SinglePass) -> SHA-256 -> upload artifact ->
//   manifest write (via manifest_writer) -> progress increment.
// Terminal finalize (flush counters to the jobs row) is handled by the caller
// after this returns, so the same pipeline works for a one-off smoke render.

const crypto = require('crypto');
const singlePass = require('./singlePass');
const s3 = require('../s3');
const manifest = require('../manifest');
const progress = require('../progress');
const logger = require('../logger');

// Render one document and record it. Returns a result descriptor. Never throws
// for a per-document render error — records an error manifest entry instead
// (partial-failure semantics: a bulk job can complete at 99/100).
async function renderDocument({ pool, jobId, documentIndex, doc }) {
  let page;
  try {
    page = await pool.acquire();
    const pdf = await singlePass.render(page, doc);
    const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    const { key, byteSize } = await s3.putArtifact(jobId, documentIndex, pdf);
    const entry = await manifest.appendRendered({
      jobId,
      documentIndex,
      documentId: doc.documentId,
      artifactKey: key,
      sha256,
      byteSize,
    });
    await progress.increment(jobId, 'completed');
    logger.info('document rendered', { jobId, documentIndex, sha256, byteSize, artifactKey: key });
    return { status: 'rendered', artifactKey: key, sha256, byteSize, manifestId: entry.id };
  } catch (err) {
    logger.error('document render failed', { jobId, documentIndex, error: err.message });
    await manifest.appendError({
      jobId,
      documentIndex,
      documentId: doc && doc.documentId,
      errorMessage: err.message,
    });
    await progress.increment(jobId, 'failed');
    return { status: 'error', error: err.message };
  } finally {
    if (page) await pool.release(page);
  }
}

module.exports = { renderDocument };
