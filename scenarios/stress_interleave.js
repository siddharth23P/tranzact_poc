'use strict';

// stress_interleave — sustained bulk pressure + interactive singles.
//
// Starts bulk work (default 2 × 100 docs × 40 rows) and then submits 20
// singles over 60s, measuring each single's time-to-presigned-URL. Run TWICE
// with the worker's reservation toggled (RENDER_SINGLE_RESERVED=1 vs 0 on the
// WORKER container — see docs/stress-runbook.md); the single-p95 delta between
// the runs is the headline number for the reserved-capacity decision.
//
//   RUN_LABEL=k1 node scenarios/stress_interleave.js
//   RUN_LABEL=k0 node scenarios/stress_interleave.js   (worker restarted with k=0)
//
// env: PDF_API, PROVENANCE, RUN_LABEL, MEM_CMD,
//      BULK_JOBS (2), BULK_DOCS (100), BULK_ROWS (40),
//      SINGLES (20), SINGLE_WINDOW_MS (60000), SLA_MS (5000)

const {
  percentile, loadDoc, submitJob, getJob, timeToUrl, startMemSampler, mdRow, today, sleep, PROVENANCE,
} = require('./lib/util');

const RUN_LABEL = process.env.RUN_LABEL || 'unlabeled-run';
const BULK_JOBS = parseInt(process.env.BULK_JOBS || '2', 10);
const BULK_DOCS = parseInt(process.env.BULK_DOCS || '100', 10);
const BULK_ROWS = parseInt(process.env.BULK_ROWS || '40', 10);
const SINGLES = parseInt(process.env.SINGLES || '20', 10);
const WINDOW_MS = parseInt(process.env.SINGLE_WINDOW_MS || '60000', 10);
const SLA_MS = parseInt(process.env.SLA_MS || '5000', 10);

async function main() {
  console.log(`\nstress_interleave [${RUN_LABEL}] — ${BULK_JOBS}×${BULK_DOCS} bulk docs (${BULK_ROWS} rows) + ${SINGLES} singles over ${WINDOW_MS / 1000}s [${PROVENANCE}]\n`);
  const sampler = startMemSampler({});
  const runId = Date.now().toString(36);

  // 1. Bulk pressure.
  const bulkIds = [];
  for (let b = 0; b < BULK_JOBS; b++) {
    const docs = Array.from({ length: BULK_DOCS }, (_, i) => loadDoc(`IL-${runId}-B${b}-${i}`, BULK_ROWS));
    const job = await submitJob(docs);
    bulkIds.push(job.id);
    console.log(`  bulk[${b}] ${job.id} queued (${BULK_DOCS} docs)`);
  }

  // 2. Singles over the window, timed individually.
  const gap = WINDOW_MS / SINGLES;
  const t0 = Date.now();
  const inflight = [];
  for (let i = 0; i < SINGLES; i++) {
    inflight.push(
      timeToUrl(loadDoc(`IL-${runId}-S${i}`)).then((r) => {
        console.log(`  single[${i}] ${r.ok ? 'ok' : `FAIL(${r.reason})`} ${r.ms}ms`);
        return r;
      })
    );
    await sleep(gap);
  }
  const singles = await Promise.all(inflight);
  const singlesDoneAt = Date.now();

  // 3. Was bulk pressure actually sustained through the window?
  let bulkStillRunning = 0;
  for (const id of bulkIds) {
    const j = await getJob(id);
    if (!['completed', 'completed_with_errors', 'failed'].includes(j.status)) bulkStillRunning++;
  }
  const mem = sampler.stop();

  const ok = singles.filter((r) => r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = percentile(lat, 50), p95 = percentile(lat, 95), p99 = percentile(lat, 99);
  const misses = ok.filter((r) => r.ms > SLA_MS).length + (singles.length - ok.length);

  console.log(`\nresults [${RUN_LABEL}]:`);
  console.log(`  singles ${ok.length}/${SINGLES} ok — p50=${p50}ms p95=${p95}ms p99=${p99}ms, SLA misses ${misses}/${SINGLES}`);
  console.log(`  bulk pressure at window end: ${bulkStillRunning}/${BULK_JOBS} bulk jobs still running${bulkStillRunning === 0 ? '  ⚠ bulk finished early — increase BULK_JOBS/BULK_ROWS' : ''}`);
  if (mem.available) console.log(`  worker RSS: peak ${mem.peakMiB} MiB, steady ${mem.steadyMiB} MiB`);

  console.log('\nmeasurements.md row:');
  console.log(mdRow([
    today(),
    `stress_interleave ${RUN_LABEL} (${BULK_JOBS}×${BULK_DOCS}×${BULK_ROWS}r bulk + ${SINGLES} singles/${WINDOW_MS / 1000}s)`,
    `single p50 ${p50} ms · p95 ${p95} ms · p99 ${p99} ms`,
    `misses ${misses}/${SINGLES} · bulk-still-running ${bulkStillRunning}/${BULK_JOBS} · RSS peak ${mem.available ? mem.peakMiB : '?'} MiB · ${PROVENANCE}`,
  ]));
  console.log(`\n(compare single p95 across RUN_LABEL=k1 vs k0 — the delta is the headline)`);

  // Let bulk drain in the background; the script's job is the single latencies.
  void singlesDoneAt;
  process.exit(singles.length - ok.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('stress_interleave crashed:', e.message); process.exit(1); });
