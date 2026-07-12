'use strict';

const crypto = require('crypto');
const express = require('express');

const logger = require('../logger');
const { validateJobRequest } = require('../validation');
const jobsRepo = require('../jobs');
const progress = require('../progress');
const s3 = require('../s3');
const queues = require('../queues');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeJob(job, { idempotent, progressSource, completed, failed }) {
  return {
    id: job.id,
    status: job.status,
    priority: job.priority,
    idempotencyKey: job.idempotency_key,
    totalDocuments: job.total_documents,
    completedDocuments: completed ?? job.completed_documents,
    failedDocuments: failed ?? job.failed_documents,
    snapshotKey: job.snapshot_key,
    errorMessage: job.error_message,
    idempotent: idempotent ?? undefined,
    progressSource: progressSource ?? undefined,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

// POST /jobs — create a single or bulk job.
//
// Operation order is load-bearing (see phase-2 review):
//   1. validate
//   2. INSERT job row as 'pending'  <-- unique idempotency_key gates here FIRST,
//      so concurrent duplicates can never double-snapshot or orphan tasks
//   3. snapshot full payload to S3   (BEFORE enqueue)
//   4. init Redis progress counters
//   5. enqueue all tasks (all-or-nothing; retried, deterministic ids)
//   6. set status='queued'           (LAST — never 'queued' with missing tasks)
// Any failure in 3–5 marks the job 'failed' with a clear error and returns 502.
router.post('/jobs', async (req, res) => {
  const body = req.body;

  // 1) Enqueue-time validation. Nothing malformed gets past this point.
  const result = validateJobRequest(body);
  if (!result.valid) {
    return res.status(400).json({
      error: 'validation_failed',
      message: 'one or more documents (or the request) failed validation',
      errors: result.topErrors,
      documents: result.documentErrors,
    });
  }

  const jobId = crypto.randomUUID();
  const priority = result.priority;
  const total = result.documentCount;
  const snapshotKey = s3.snapshotKey(jobId);
  const idempotencyKey = body.idempotencyKey || null;

  // 2) Persist the job row (idempotency-key dedupe happens here).
  let created;
  let job;
  try {
    const ins = await jobsRepo.insertJob({
      id: jobId,
      idempotencyKey,
      priority,
      totalDocuments: total,
      snapshotKey,
    });
    job = ins.job;
    created = ins.created;
  } catch (err) {
    logger.error('job insert failed', { error: err.message });
    return res.status(500).json({ error: 'internal_error', message: 'could not persist job' });
  }

  // Idempotent replay: an existing job with this key — return it untouched.
  if (!created) {
    logger.info('idempotent replay', { jobId: job.id, idempotencyKey });
    return res.status(200).json(serializeJob(job, { idempotent: true }));
  }

  // 3) Snapshot the full validated payload to S3 BEFORE enqueue.
  try {
    await s3.putSnapshot(job.id, {
      jobId: job.id,
      priority,
      documentCount: total,
      documents: body.documents,
    });
  } catch (err) {
    logger.error('snapshot upload failed', { jobId: job.id, error: err.message });
    await jobsRepo.setStatus(job.id, 'failed', `snapshot upload failed: ${err.message}`);
    return res
      .status(502)
      .json({ error: 'snapshot_failed', message: 'could not write job snapshot to storage' });
  }

  // 4) Initialise live progress counters in Redis.
  try {
    await progress.init(job.id, total);
  } catch (err) {
    logger.error('progress init failed', { jobId: job.id, error: err.message });
    await jobsRepo.setStatus(job.id, 'failed', `progress init failed: ${err.message}`);
    return res.status(502).json({ error: 'enqueue_failed', message: 'could not initialise progress' });
  }

  // 5) Enqueue one task per document onto the priority-appropriate queue
  //    (all-or-nothing; retried with deterministic ids).
  try {
    const enq = await queues.enqueueDocuments(job.id, total, priority);
    logger.info('job enqueued', { jobId: job.id, priority, ...enq });
  } catch (err) {
    logger.error('enqueue failed', { jobId: job.id, error: err.message });
    await jobsRepo.setStatus(job.id, 'failed', `enqueue failed: ${err.message}`);
    return res.status(502).json({ error: 'enqueue_failed', message: 'could not enqueue render tasks' });
  }

  // 6) Promote to 'queued' LAST — now every task is enqueued and the snapshot
  //    exists. Only from here can a worker legitimately render this job.
  let queuedJob = job;
  try {
    queuedJob = await jobsRepo.setStatus(job.id, 'queued');
  } catch (err) {
    // Tasks are enqueued and idempotent; failing to flip the flag is not fatal
    // to correctness, but surface it. The job stays 'pending' and can be re-driven.
    logger.error('status->queued failed', { jobId: job.id, error: err.message });
  }

  return res.status(201).json(serializeJob(queuedJob, { idempotent: false }));
});

// GET /jobs/:id — status + progress. Live counters come from Redis while the
// job renders; after terminal flush they come from the jobs row.
router.get('/jobs/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ error: 'not_found', message: 'no such job' });
  }

  let job;
  try {
    job = await jobsRepo.getById(id);
  } catch (err) {
    logger.error('job fetch failed', { id, error: err.message });
    return res.status(500).json({ error: 'internal_error' });
  }
  if (!job) {
    return res.status(404).json({ error: 'not_found', message: 'no such job' });
  }

  let progressSource = 'postgres';
  let completed = job.completed_documents;
  let failed = job.failed_documents;
  try {
    const live = await progress.readLive(id);
    if (live) {
      progressSource = 'redis';
      completed = live.completed;
      failed = live.failed;
    }
  } catch (err) {
    // Redis unavailable — fall back to the durable jobs row.
    logger.warn('progress read failed, using jobs row', { id, error: err.message });
  }

  return res.status(200).json(serializeJob(job, { progressSource, completed, failed }));
});

module.exports = router;
