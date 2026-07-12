'use strict';

// Two priority queues, single > bulk. A single-document job's task goes to the
// `render-single` queue; a bulk job's N tasks go to `render-bulk`. Workers
// (phase 3) drain single ahead of bulk, so interactive single-doc requests
// aren't stuck behind a large bulk run.
//
// Work is enqueued as ONE BullMQ job per document task (not per Job). This is
// what makes per-document progress, per-document manifest entries, and partial
// failure (a bulk job completing at 99/100) fall out naturally: each unit
// renders, increments a counter, and writes its own ledger row.

const { Queue } = require('bullmq');
const { buildConnectionOptions } = require('./redis');

const QUEUE_SINGLE = 'render-single';
const QUEUE_BULK = 'render-bulk';

const connection = buildConnectionOptions();

const singleQueue = new Queue(QUEUE_SINGLE, { connection });
const bulkQueue = new Queue(QUEUE_BULK, { connection });

function queueForPriority(priority) {
  return priority === 'single' ? singleQueue : bulkQueue;
}

// Enqueue one task per document into the priority-appropriate queue.
//
// All-or-nothing from the job's perspective:
//   - Task job ids are deterministic (`${jobId}-${index}`), so BullMQ de-dupes
//     — a re-run adds only the missing tasks, never a duplicate render.
//   - We use a single addBulk (near-atomic pipeline) and, if it throws after a
//     partial add, RETRY. Because of the deterministic ids the retry converges
//     to exactly N tasks present.
//   - If it still fails, we throw. The caller then marks the job 'failed', and
//     the worker guard (only render tasks whose job is queued/processing) means
//     any task that did leak into the queue is never rendered. So the outcome is
//     always: all N tasks enqueued + status=queued, OR job=failed.
//
// (BullMQ forbids ':' in custom ids — reserved key delimiter — so we join '-'.)
async function enqueueDocuments(jobId, documentCount, priority, { attempts = 3 } = {}) {
  const queue = queueForPriority(priority);
  const jobs = [];
  for (let index = 0; index < documentCount; index++) {
    jobs.push({
      name: 'render-document',
      data: { jobId, documentIndex: index },
      opts: {
        jobId: `${jobId}-${index}`,
        removeOnComplete: 1000,
        removeOnFail: false,
        // Infra-level retries (e.g. the task is picked up in the small window
        // before the API flips the job to 'queued' — the worker throws to
        // requeue instead of dropping the task). Per-DOCUMENT render errors are
        // caught inside the pipeline and recorded as manifest error entries;
        // they never throw, so they are NOT retried by this.
        attempts: 5,
        backoff: { type: 'exponential', delay: 500 },
      },
    });
  }

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await queue.addBulk(jobs);
      return { queue: queue.name, enqueued: jobs.length, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // brief backoff before retrying the (idempotent) bulk add
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw lastErr;
}

async function counts() {
  const [single, bulk] = await Promise.all([
    singleQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    bulkQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
  ]);
  return { [QUEUE_SINGLE]: single, [QUEUE_BULK]: bulk };
}

async function close() {
  await Promise.all([singleQueue.close(), bulkQueue.close()]);
}

module.exports = {
  QUEUE_SINGLE,
  QUEUE_BULK,
  singleQueue,
  bulkQueue,
  queueForPriority,
  enqueueDocuments,
  counts,
  close,
};
