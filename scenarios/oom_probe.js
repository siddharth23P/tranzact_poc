'use strict';

// oom_probe — find the SinglePass row-count ceiling inside the memory-capped
// worker container; this number sets CHUNK_THRESHOLD.
//
// PROBE mode (worker must run with CHUNK_THRESHOLD=999999 so big docs are
// FORCED through SinglePass — see runbook):
//   node scenarios/oom_probe.js probe
//   Submits single-doc jobs at 500/1000/1500/2000/3000 rows sequentially.
//   Per size: completed (duration + RSS peak) or the failure signature
//   (job stuck/failed, container OOMKilled flag, restart count, BullMQ failed
//   reasons). Stops at the first death.
//
// CONTROL mode (worker back on normal CHUNK_THRESHOLD):
//   node scenarios/oom_probe.js control <rows>
//   Renders the killer size via ChunkedMerge and asserts it completes.
//
// env: PDF_API, PROVENANCE, MEM_CMD, SIZES (csv), PER_SIZE_TIMEOUT_MS (240000),
//      WORKER_CONTAINER (for docker inspect; default: resolve via compose),
//      REDIS_HOST/PORT (to read BullMQ failed reasons; optional)

const { execSync } = require('child_process');
const path = require('path');
const { createRequire } = require('module');
const {
  loadDoc, submitJob, pollTerminal, getManifest, startMemSampler, mdRow, today, PROVENANCE,
} = require('./lib/util');

const SIZES = (process.env.SIZES || '500,1000,1500,2000,3000').split(',').map((s) => parseInt(s, 10));
const TIMEOUT_MS = parseInt(process.env.PER_SIZE_TIMEOUT_MS || '240000', 10);

const pdfServiceRequire = createRequire(path.join(__dirname, '..', 'pdf-service', 'package.json'));

function dockerInspectWorker() {
  try {
    const name =
      process.env.WORKER_CONTAINER ||
      execSync('docker compose ps -q worker', { timeout: 5000 }).toString().trim();
    if (!name) return null;
    const out = execSync(
      `docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}} {{.State.Status}}' ${name}`,
      { timeout: 5000 }
    ).toString().trim();
    const [oomKilled, restartCount, status] = out.split(' ');
    return { oomKilled: oomKilled === 'true', restartCount: parseInt(restartCount, 10), status };
  } catch (_) {
    return null; // no docker access (e.g. local run) — signature will be partial
  }
}

async function bullFailedReasons(jobId) {
  try {
    const { Queue } = pdfServiceRequire('bullmq');
    const conn = { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10), maxRetriesPerRequest: null };
    const reasons = [];
    for (const qname of ['render-single', 'render-bulk']) {
      const q = new Queue(qname, { connection: conn });
      const failed = await q.getFailed(0, 20);
      for (const t of failed) {
        if (t.data?.jobId === jobId) reasons.push(`${qname}: ${t.failedReason} (attempts ${t.attemptsMade})`);
      }
      await q.close();
    }
    return reasons;
  } catch (e) {
    return [`(could not read BullMQ failed set: ${e.message})`];
  }
}

// Big doc with bounded numerics (stays under validation caps at any row count here).
function bigDoc(rows, runId) {
  const doc = loadDoc(`OOM-${runId}-${rows}`, rows);
  return doc;
}

async function probe() {
  const runId = Date.now().toString(36);
  console.log(`\noom_probe PROBE — forced SinglePass at ${SIZES.join('/')} rows [${PROVENANCE}]`);
  console.log('(worker must be running with CHUNK_THRESHOLD=999999 — see runbook)\n');
  const rows = [];
  const baseline = dockerInspectWorker();

  for (const size of SIZES) {
    console.log(`--- ${size} rows ---`);
    const sampler = startMemSampler({});
    const t0 = Date.now();
    const job = await submitJob([bigDoc(size, runId)]);
    const { job: fin, timedOut } = await pollTerminal(job.id, { intervalMs: 500, timeoutMs: TIMEOUT_MS });
    const ms = Date.now() - t0;
    const mem = sampler.stop();
    const memNote = mem.available ? `RSS peak ${mem.peakMiB} MiB` : 'RSS n/a';

    if (!timedOut && fin.status === 'completed') {
      const manifest = await getManifest(job.id);
      console.log(`  ✓ completed in ${ms}ms (${manifest.documents[0].renderStrategy}, ${memNote})`);
      rows.push([today(), `oom_probe SinglePass ${size} rows`, `completed ${ms} ms`, `${memNote} · ${PROVENANCE}`]);
      continue;
    }

    // Death: collect the failure signature and stop.
    const inspect = dockerInspectWorker();
    const reasons = await bullFailedReasons(job.id);
    console.log(`  ✗ DIED at ${size} rows — job status=${fin.status}${timedOut ? ' (poll timeout)' : ''} after ${ms}ms`);
    if (inspect) {
      console.log(`    container: OOMKilled=${inspect.oomKilled} restarts=${inspect.restartCount}${baseline ? ` (was ${baseline.restartCount})` : ''} state=${inspect.status}`);
    } else {
      console.log('    container introspection unavailable (no docker access from here)');
    }
    for (const r of reasons) console.log(`    bullmq: ${r}`);
    console.log(`    ${memNote}`);
    rows.push([today(), `oom_probe SinglePass ${size} rows`, `DIED (${timedOut ? 'stuck' : fin.status})`,
      `${inspect ? `OOMKilled=${inspect.oomKilled} restarts+${inspect.restartCount - (baseline?.restartCount ?? 0)}` : 'no-inspect'} · ${memNote} · ${PROVENANCE}`]);
    console.log(`\n=> threshold: last size to complete is the SinglePass ceiling; set CHUNK_THRESHOLD comfortably below it.`);
    break;
  }

  console.log('\nmeasurements.md rows:');
  for (const r of rows) console.log(mdRow(r));
}

async function control(size) {
  const runId = Date.now().toString(36);
  console.log(`\noom_probe CONTROL — ${size} rows via ChunkedMerge [${PROVENANCE}]`);
  console.log('(worker must be back on its normal CHUNK_THRESHOLD)\n');
  const sampler = startMemSampler({});
  const t0 = Date.now();
  const job = await submitJob([bigDoc(size, runId)]);
  const { job: fin, timedOut } = await pollTerminal(job.id, { intervalMs: 500, timeoutMs: TIMEOUT_MS });
  const ms = Date.now() - t0;
  const mem = sampler.stop();

  if (timedOut || fin.status !== 'completed') {
    console.error(`  ✗ control FAILED: status=${fin.status}${timedOut ? ' (timeout)' : ''}`);
    process.exit(1);
  }
  const manifest = await getManifest(job.id);
  const strategy = manifest.documents[0].renderStrategy;
  console.log(`  ✓ completed in ${ms}ms via ${strategy}${mem.available ? `, RSS peak ${mem.peakMiB} MiB` : ''}`);
  if (strategy !== 'ChunkedMerge') {
    console.error(`  ✗ expected ChunkedMerge, got ${strategy} — is the worker back on the normal threshold?`);
    process.exit(1);
  }
  console.log('\nmeasurements.md row:');
  console.log(mdRow([today(), `oom_probe ChunkedMerge ${size} rows (control)`, `completed ${ms} ms`,
    `RSS peak ${mem.available ? mem.peakMiB : '?'} MiB · survives where SinglePass died · ${PROVENANCE}`]));
}

const mode = process.argv[2];
if (mode === 'probe') probe().catch((e) => { console.error('probe crashed:', e.message); process.exit(1); });
else if (mode === 'control') control(parseInt(process.argv[3] || '2000', 10)).catch((e) => { console.error('control crashed:', e.message); process.exit(1); });
else { console.error('usage: oom_probe.js probe | control <rows>'); process.exit(2); }
