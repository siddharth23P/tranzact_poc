'use strict';

// Progress counters live in REDIS while a job renders — this is the hot path
// that GET /jobs/{id} polls and that workers increment per document. The jobs
// table columns (completed_documents / failed_documents) are the *flushed*
// terminal snapshot: written once, when the job reaches a terminal state, so
// the durable record survives Redis eviction/flush.
//
//   render loop:   HINCRBY job:{id}:progress completed|failed   (Redis, live)
//   terminal:      flushToJobsRow() -> UPDATE jobs ...           (Postgres, once)
//
// Rationale for Redis-first: increments are frequent and concurrent across
// worker processes; a Redis hash gives atomic per-field increments without
// row-lock contention on the jobs table, and GET /jobs reads are cheap.

const db = require('./db');
const { getRedis } = require('./redis');

const TTL_SECONDS = 60 * 60 * 24; // safety expiry so abandoned keys don't leak

function key(jobId) {
  return `job:${jobId}:progress`;
}

// Initialise the live counters at enqueue time.
async function init(jobId, total) {
  const r = getRedis();
  await r
    .multi()
    .hset(key(jobId), { completed: 0, failed: 0, total })
    .expire(key(jobId), TTL_SECONDS)
    .exec();
}

// Atomic per-document increment. field ∈ {'completed','failed'}.
async function increment(jobId, field) {
  if (field !== 'completed' && field !== 'failed') {
    throw new Error(`invalid progress field: ${field}`);
  }
  return getRedis().hincrby(key(jobId), field, 1);
}

// Read live counters from Redis. Returns null if no live key exists (e.g. the
// job already reached terminal state and the key was flushed/expired).
async function readLive(jobId) {
  const h = await getRedis().hgetall(key(jobId));
  if (!h || Object.keys(h).length === 0) return null;
  return {
    completed: parseInt(h.completed || '0', 10),
    failed: parseInt(h.failed || '0', 10),
    total: parseInt(h.total || '0', 10),
  };
}

// After incrementing, decide whether THIS task is the one that completes the
// job. Uses SET NX on a `finalized` marker so exactly one task finalizes, even
// if the last two documents finish concurrently. Returns { done, completed,
// failed } — done=true only for the single winning task.
async function claimFinalizeIfDone(jobId, total) {
  const live = await readLive(jobId);
  const completed = live ? live.completed : 0;
  const failed = live ? live.failed : 0;
  if (completed + failed < total) return { done: false, completed, failed };

  // All documents accounted for — race to claim the finalize.
  const won = await getRedis().set(`job:${jobId}:finalized`, '1', 'EX', TTL_SECONDS, 'NX');
  return { done: won === 'OK', completed, failed };
}

// Flush live counters into the durable jobs row at terminal state, set final
// status, then drop the Redis key. Called once by the worker when
// completed+failed === total.
async function flushToJobsRow(jobId, finalStatus) {
  const live = await readLive(jobId);
  const completed = live ? live.completed : 0;
  const failed = live ? live.failed : 0;

  await db.appPool.query(
    `UPDATE jobs
        SET completed_documents = $2,
            failed_documents    = $3,
            status              = $4,
            updated_at          = now()
      WHERE id = $1`,
    [jobId, completed, failed, finalStatus]
  );
  await getRedis().del(key(jobId));
  return { completed, failed, status: finalStatus };
}

module.exports = { init, increment, readLive, claimFinalizeIfDone, flushToJobsRow, key };
