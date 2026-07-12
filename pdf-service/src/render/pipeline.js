'use strict';

// The per-document render pipeline, shared by the worker and the smoke test:
//   acquire page -> render (SinglePass) -> SHA-256 -> upload artifact ->
//   manifest write (via manifest_writer) -> progress increment.
// Terminal finalize (flush counters to the jobs row) is handled by the caller
// after this returns, so the same pipeline works for a one-off smoke render.

const crypto = require('crypto');
const { renderWithSelectedStrategy } = require('./selectStrategy');
const s3 = require('../s3');
const manifest = require('../manifest');
const progress = require('../progress');
const logger = require('../logger');

// Error classification. INFRASTRUCTURE failures (browser/page death, network,
// storage) are transient: the task must be RETRIED by BullMQ, not sealed as a
// per-document error. Only DOCUMENT-level failures (the data itself cannot
// render) become manifest error entries. AWS SDK errors carry $metadata.
const INFRA_ERROR_RE =
  /protocol error|target closed|session closed|browser has disconnected|connection closed|browser was not found|detached frame|frame.*detached|browser.*closed|econnrefused|econnreset|etimedout|eai_again|epipe|socket hang up|net::err/i;

function isInfraError(err) {
  return INFRA_ERROR_RE.test(err.message || '') || err.$metadata !== undefined;
}

// Render one document and record it. `lane` ('single' | 'bulk') is threaded to
// the BrowserPool so the reservation is enforced structurally. Never throws for
// a per-document render error — records an error manifest entry instead
// (partial-failure semantics: a bulk job can complete at 99/100).
async function renderDocument({ pool, jobId, documentIndex, doc, lane = 'single' }) {
  let page;
  try {
    page = await pool.acquire(lane);
    const { pdf, strategy } = await renderWithSelectedStrategy(page, doc);
    const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
    const { key, byteSize } = await s3.putArtifact(jobId, documentIndex, pdf);
    const entry = await manifest.appendRendered({
      jobId,
      documentIndex,
      documentId: doc.documentId,
      artifactKey: key,
      sha256,
      byteSize,
      renderStrategy: strategy,
    });
    await progress.increment(jobId, 'completed');
    logger.info('document rendered', {
      jobId,
      documentIndex,
      strategy,
      sha256,
      byteSize,
      artifactKey: key,
    });
    return { status: 'rendered', strategy, artifactKey: key, sha256, byteSize, manifestId: entry.id };
  } catch (err) {
    // Transient infra failure (browser killed, storage/network down): rethrow
    // so BullMQ retries the whole task — the document is NOT failed.
    if (isInfraError(err)) {
      logger.warn('infra error during render — task will retry', {
        jobId,
        documentIndex,
        error: err.message,
      });
      throw err;
    }
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
    if (page) await pool.release(page, lane);
  }
}

module.exports = { renderDocument };
