'use strict';

// chaos_kill_chromium — kill -9 the browser mid-render; assert the affected
// tasks RETRY (no sealed error entries) and the job completes 100%.
//
// Exercises two resilience paths added for this scenario:
//   - infra-error classification: a dead browser throws out of the render
//     pipeline so BullMQ retries the task (it is NOT recorded as a document
//     error);
//   - BrowserPool relaunch: the worker rebuilds Chromium + pages and keeps
//     draining the queue.
//
//   node scenarios/chaos_kill_chromium.js
// env: PDF_API, PROVENANCE,
//      KILL_CMD  (default: docker compose exec -T worker pkill -9 chromium)
//      KILL_AFTER_MS (3000), CHAOS_DOCS (20), CHAOS_ROWS (60),
//      REDIS_HOST/PORT (to show attemptsMade>1 evidence)

const { execSync } = require('child_process');
const path = require('path');
const { createRequire } = require('module');
const { loadDoc, submitJob, pollTerminal, getManifest, sleep, mdRow, today, PROVENANCE } = require('./lib/util');

// Defaults sized so renders are LONG (400-row docs, several seconds each) and
// the kill lands while renders are provably in flight — otherwise the run is
// inconclusive (asserted below via retry evidence).
const KILL_CMD = process.env.KILL_CMD || 'docker compose exec -T worker pkill -9 chromium';
const KILL_AFTER_MS = parseInt(process.env.KILL_AFTER_MS || '1500', 10);
const DOCS = parseInt(process.env.CHAOS_DOCS || '10', 10);
const ROWS = parseInt(process.env.CHAOS_ROWS || '400', 10);

const pdfServiceRequire = createRequire(path.join(__dirname, '..', 'pdf-service', 'package.json'));

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function retryEvidence(jobId) {
  try {
    const { Queue } = pdfServiceRequire('bullmq');
    const conn = { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10), maxRetriesPerRequest: null };
    let retried = 0;
    for (const qname of ['render-bulk', 'render-single']) {
      const q = new Queue(qname, { connection: conn });
      const done = await q.getCompleted(0, 500);
      retried += done.filter((t) => t.data?.jobId === jobId && t.attemptsMade > 1).length;
      await q.close();
    }
    return retried;
  } catch (e) {
    return `unavailable (${e.message})`;
  }
}

async function main() {
  console.log(`\nchaos_kill_chromium — ${DOCS} docs × ${ROWS} rows, kill at t+${KILL_AFTER_MS}ms [${PROVENANCE}]\n`);

  const runId = Date.now().toString(36);
  const docs = Array.from({ length: DOCS }, (_, i) => loadDoc(`CHAOS-${runId}-${i}`, ROWS));
  const t0 = Date.now();
  const job = await submitJob(docs);
  console.log(`job ${job.id} queued (${DOCS} docs)`);

  await sleep(KILL_AFTER_MS);
  console.log(`killing chromium at t+${Date.now() - t0}ms:  $ ${KILL_CMD}`);
  try {
    execSync(KILL_CMD, { timeout: 10000, stdio: 'pipe' });
  } catch (e) {
    // pkill exits 0 on kill; non-zero can mean "no process matched" — surface it.
    console.log(`  (kill command exited non-zero: ${e.status} — verify the pattern matched a live browser)`);
  }

  console.log('waiting for the job to recover and complete:');
  const { job: fin, timedOut } = await pollTerminal(job.id, { intervalMs: 1000, timeoutMs: 300000 });
  const ms = Date.now() - t0;

  if (timedOut) bad(`job did not reach terminal state within timeout (status=${fin.status})`);
  else if (fin.status !== 'completed') bad(`job terminal but status=${fin.status} (completed=${fin.completedDocuments}, failed=${fin.failedDocuments}) — kill produced sealed errors instead of retries`);
  else ok(`job completed ${fin.completedDocuments}/${fin.totalDocuments} in ${ms}ms despite the kill`);

  const manifest = await getManifest(job.id);
  const errorEntries = manifest.documents.filter((d) => d.status === 'error');
  errorEntries.length === 0
    ? ok('no error entries in the manifest (crash was retried, not sealed)')
    : bad(`${errorEntries.length} sealed error entries: ${errorEntries.map((d) => d.error).join(' | ').slice(0, 200)}`);

  const retried = await retryEvidence(job.id);
  console.log(`  retry evidence: tasks with attemptsMade>1 for this job: ${retried}`);
  if (typeof retried === 'number' && retried === 0) {
    bad('INCONCLUSIVE: no task was actually interrupted (kill landed between renders) — rerun with larger CHAOS_ROWS or earlier KILL_AFTER_MS');
  } else if (typeof retried === 'number') {
    ok(`${retried} interrupted task(s) retried instead of sealing errors`);
  }

  console.log('\nmeasurements.md row:');
  console.log(mdRow([today(), `chaos_kill_chromium (${DOCS}×${ROWS}r, kill@${KILL_AFTER_MS}ms)`,
    process.exitCode ? 'FAILED' : `recovered — completed ${ms} ms`,
    `retried-tasks ${retried} · ${PROVENANCE}`]));
  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch((e) => { console.error('chaos_kill_chromium crashed:', e.message); process.exit(1); });
