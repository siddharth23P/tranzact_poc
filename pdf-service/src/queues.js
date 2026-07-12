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

// Enqueue one task per document into the priority-appropriate queue. Task job
// ids are deterministic (`${jobId}-${index}`) so a retried enqueue de-dupes at
// the BullMQ layer instead of double-rendering. (BullMQ forbids ':' in custom
// ids — it's a reserved key delimiter — so we join with '-'.)
async function enqueueDocuments(jobId, documentCount, priority) {
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
      },
    });
  }
  await queue.addBulk(jobs);
  return { queue: queue.name, enqueued: jobs.length };
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
