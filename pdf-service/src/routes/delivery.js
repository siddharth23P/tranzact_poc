'use strict';

const express = require('express');
const logger = require('../logger');
const jobsRepo = require('../jobs');
const s3 = require('../s3');
const { buildManifestPayload, isTerminal } = require('../delivery');
const { ensureArchive } = require('../archive');
const config = require('../config');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadJob(req, res) {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'not_found', message: 'no such job' });
    return null;
  }
  const job = await jobsRepo.getById(id);
  if (!job) {
    res.status(404).json({ error: 'not_found', message: 'no such job' });
    return null;
  }
  return job;
}

// GET /jobs/:id/manifest — per-document delivery manifest: presigned URL +
// sha256 + size for rendered docs, error message for failed ones, job-level
// counts, snapshot timestamp. URLs are signed at read time with the configured
// expiry. Available while rendering too (documents appear as they finish).
router.get('/jobs/:id/manifest', async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    res.json(await buildManifestPayload(job));
  } catch (err) {
    logger.error('manifest build failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /jobs/:id/manifest/refresh — re-sign the manifest URLs for a job that
// has reached a terminal state (client stored a manifest whose URLs expired).
router.post('/jobs/:id/manifest/refresh', async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (!isTerminal(job.status)) {
      return res.status(409).json({
        error: 'job_not_terminal',
        message: `manifest refresh is available once the job is terminal (status: ${job.status})`,
      });
    }
    res.json(await buildManifestPayload(job));
  } catch (err) {
    logger.error('manifest refresh failed', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /jobs/:id/archive — lazy zip fallback. First call builds the zip from the
// S3 artifacts (streamed) and caches it at archives/{jobId}.zip; every call
// redirects (302) to the archive's presigned URL.
router.get('/jobs/:id/archive', async (req, res) => {
  try {
    const job = await loadJob(req, res);
    if (!job) return;
    if (!isTerminal(job.status)) {
      return res.status(409).json({
        error: 'job_not_terminal',
        message: `archive is available once the job is terminal (status: ${job.status})`,
      });
    }
    if (job.status === 'failed' && job.completed_documents === 0) {
      return res.status(409).json({
        error: 'no_artifacts',
        message: 'job produced no rendered documents to archive',
      });
    }

    const key = await ensureArchive(job);
    const url = await s3.presignGet(key, config.render.presignExpirySeconds);
    res.redirect(302, url);
  } catch (err) {
    logger.error('archive request failed', { id: req.params.id, error: err.message });
    res.status(502).json({ error: 'archive_failed', message: err.message });
  }
});

module.exports = router;
