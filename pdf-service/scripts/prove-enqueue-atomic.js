'use strict';

// Proves the enqueue path is all-or-nothing from the job's perspective:
// when task enqueue fails AFTER the snapshot succeeded, the job is marked
// 'failed' with a clear error, it is NEVER left 'queued', and the API returns
// a clean 5xx (not a partial success).
//
// We inject the failure by stubbing queues.enqueueDocuments to throw — then
// drive the REAL Express app + real Postgres/Redis/S3. Run against migrated
// local infra with the same env as the API:
//   node scripts/prove-enqueue-atomic.js

const queues = require('../src/queues');
const db = require('../src/db');

// Force enqueue to fail (simulate Redis/BullMQ blowing up mid-add).
queues.enqueueDocuments = async () => {
  throw new Error('simulated BullMQ addBulk failure');
};

// Require the app AFTER stubbing so the route uses the stubbed function.
const { createApp } = require('../src/app');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function main() {
  const app = createApp();
  const server = app.listen(3998);
  const base = 'http://127.0.0.1:3998';

  const body = JSON.stringify({
    documents: [
      { documentId: 'D1', poNumber: 'PO-1', vendor: { name: 'Acme' },
        lineItems: [{ description: 'W', quantity: 1, unitPrice: 5 }] },
    ],
  });

  console.log('\nPOST /jobs with enqueue forced to fail:');
  const res = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  const json = await res.json();
  console.log(`  response: HTTP ${res.status} ${JSON.stringify(json)}`);

  if (res.status >= 500 && res.status < 600) ok(`clean ${res.status} (not a partial success)`);
  else bad(`expected 5xx, got ${res.status}`);
  if (json.error === 'enqueue_failed') ok('error=enqueue_failed'); else bad(`unexpected error: ${json.error}`);

  // The job row must exist and be 'failed' — never 'queued'.
  const { rows } = await db.appPool.query(
    `SELECT status, error_message FROM jobs ORDER BY created_at DESC LIMIT 1`
  );
  const job = rows[0];
  console.log(`  latest job row: status=${job.status} error=${JSON.stringify(job.error_message)}`);
  if (job.status === 'failed') ok("job status='failed'"); else bad(`expected failed, got ${job.status}`);
  if (/enqueue failed/i.test(job.error_message || '')) ok('error_message explains the failure');
  else bad('error_message missing/unclear');

  // Nothing should be left 'queued' from this attempt.
  const { rows: q } = await db.appPool.query(`SELECT count(*)::int n FROM jobs WHERE status='queued'`);
  console.log(`  jobs currently 'queued': ${q[0].n} (from this isolated run expect 0)`);

  server.close();
  await db.close();
  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (enqueue failure => job failed, no partial queued)\n');
}

main().catch(async (e) => { console.error('crashed:', e.message); process.exitCode = 1; try { await db.close(); } catch (_) {} });
