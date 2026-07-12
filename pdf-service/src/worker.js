'use strict';

// Render worker. Two BullMQ Workers over ONE shared BrowserPool:
//   render-single: concurrency = N            (fast lane, may use all pages)
//   render-bulk:   concurrency = N - k        (capped so >=k pages stay free
//                                              for singles — reserved-capacity
//                                              SLA guarantee; see docs/queueing.md)
//
// Per task: guard on job state -> load snapshot (cached) -> render+seal+manifest
// (src/render/pipeline.js) -> on last document, flush progress to the jobs row.

const { Worker } = require('bullmq');
const config = require('./config');
const logger = require('./logger');
const { buildConnectionOptions } = require('./redis');
const { QUEUE_SINGLE, QUEUE_BULK } = require('./queues');
const { BrowserPool } = require('./browserPool');
const { renderDocument } = require('./render/pipeline');
const jobsRepo = require('./jobs');
const progress = require('./progress');
const s3 = require('./s3');

const N = config.render.poolSize;
const K = Math.max(1, config.render.singleReserved);
const BULK_CONCURRENCY = Math.max(1, N - K);

// In-memory snapshot cache: load each job's frozen payload once, not per task.
// Keyed by jobId, evicted on finalize. Workers render ONLY from this snapshot.
const snapshotCache = new Map();
function getSnapshot(jobId) {
  let p = snapshotCache.get(jobId);
  if (!p) {
    p = s3.getObjectString(s3.snapshotKey(jobId)).then((s) => JSON.parse(s));
    snapshotCache.set(jobId, p);
  }
  return p;
}

function makeProcessor(pool, lane) {
  return async function processTask(job) {
    const { jobId, documentIndex } = job.data;

    const row = await jobsRepo.getById(jobId);
    if (!row) {
      logger.warn('task for unknown job, skipping', { jobId, documentIndex });
      return;
    }
    // All-or-nothing guard: never render a job that isn't queued/processing.
    // A task that leaked onto a failed/pending job is acked without rendering.
    if (row.status !== 'queued' && row.status !== 'processing') {
      logger.warn('job not renderable, skipping task', { jobId, documentIndex, status: row.status });
      return;
    }
    if (row.status === 'queued') await jobsRepo.markProcessing(jobId);

    const snapshot = await getSnapshot(jobId);
    const doc = snapshot.documents[documentIndex];

    await renderDocument({ pool, jobId, documentIndex, doc, lane });

    // Terminal check — exactly one task wins the finalize.
    const fin = await progress.claimFinalizeIfDone(jobId, row.total_documents);
    if (fin.done) {
      const finalStatus = progress.terminalStatus(fin.completed, fin.failed);
      await progress.flushToJobsRow(jobId, finalStatus);
      snapshotCache.delete(jobId);
      logger.info('job finalized', {
        jobId,
        status: finalStatus,
        completed: fin.completed,
        failed: fin.failed,
        total: row.total_documents,
      });
    }
  };
}

async function main() {
  logger.info('worker starting', { poolSize: N, singleReserved: K, bulkConcurrency: BULK_CONCURRENCY });

  const pool = new BrowserPool();
  await pool.start();

  const connection = buildConnectionOptions();

  // Lane-bound processors: the pool enforces the reservation structurally, but
  // we still cap the bulk worker's concurrency to avoid pointlessly pulling
  // more bulk jobs than the pool will admit.
  const singleWorker = new Worker(QUEUE_SINGLE, makeProcessor(pool, 'single'), {
    connection,
    concurrency: N,
  });
  const bulkWorker = new Worker(QUEUE_BULK, makeProcessor(pool, 'bulk'), {
    connection,
    concurrency: BULK_CONCURRENCY,
  });

  for (const [name, w] of [['single', singleWorker], ['bulk', bulkWorker]]) {
    w.on('failed', (job, err) =>
      logger.error('bullmq job failed', { queue: name, jobId: job && job.id, error: err.message })
    );
    w.on('error', (err) => logger.error('bullmq worker error', { queue: name, error: err.message }));
  }

  logger.info('worker ready', { queues: [QUEUE_SINGLE, QUEUE_BULK] });

  const shutdown = async (signal) => {
    logger.info('worker shutting down', { signal });
    try {
      await Promise.all([singleWorker.close(), bulkWorker.close()]);
      await pool.close();
    } catch (err) {
      logger.warn('worker shutdown error', { error: err.message });
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('worker failed to start', { error: err.message });
  process.exit(1);
});
