'use strict';

// Clarification 3 — a 99/100 job must NOT report plain 'completed'.
//
// Part A: unit-check the tri-state function.
// Part B: integration — drive real Redis counters (1 rendered + 1 failed) and
// the real terminal flush, then assert the jobs row ends 'completed_with_errors'
// with completed_documents=1, failed_documents=1.
//
//   node scripts/prove-terminal-status.js

const crypto = require('crypto');
const db = require('../src/db');
const redis = require('../src/redis');
const progress = require('../src/progress');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }
async function cleanup() { try { await redis.close(); } catch (_) {} try { await db.close(); } catch (_) {} }

async function main() {
  console.log('\nTerminal status proof\n');

  // Part A — pure function.
  const cases = [
    [2, 0, 'completed'],
    [1, 1, 'completed_with_errors'],
    [99, 1, 'completed_with_errors'],
    [0, 3, 'failed'],
  ];
  for (const [c, f, expected] of cases) {
    const got = progress.terminalStatus(c, f);
    got === expected
      ? ok(`terminalStatus(${c},${f}) = ${got}`)
      : bad(`terminalStatus(${c},${f}) = ${got}, expected ${expected}`);
  }

  // Part B — integration through the real flush.
  const jobId = crypto.randomUUID();
  await db.appPool.query(
    `INSERT INTO jobs (id, status, priority, total_documents) VALUES ($1,'processing','bulk',2)`,
    [jobId]
  );
  await progress.init(jobId, 2);
  await progress.increment(jobId, 'completed');
  await progress.increment(jobId, 'failed');

  const fin = await progress.claimFinalizeIfDone(jobId, 2);
  if (!fin.done) bad('expected finalize to be claimed');
  const finalStatus = progress.terminalStatus(fin.completed, fin.failed);
  await progress.flushToJobsRow(jobId, finalStatus);

  const { rows } = await db.appPool.query(
    'SELECT status, completed_documents, failed_documents FROM jobs WHERE id=$1',
    [jobId]
  );
  const job = rows[0];
  console.log(`  jobs row: status=${job.status} completed=${job.completed_documents} failed=${job.failed_documents}`);
  job.status === 'completed_with_errors'
    ? ok("status='completed_with_errors' (not plain 'completed')")
    : bad(`status=${job.status}`);
  job.completed_documents === 1 && job.failed_documents === 1
    ? ok('rendered/failed counts on the job row = 1/1')
    : bad(`counts wrong: ${job.completed_documents}/${job.failed_documents}`);

  await cleanup();
  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch(async (e) => { console.error('crashed:', e.message); process.exitCode = 1; await cleanup(); });
