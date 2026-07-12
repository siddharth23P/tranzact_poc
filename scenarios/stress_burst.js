'use strict';

// stress_burst — 50 single jobs submitted over 5 seconds.
//
// Reports p50/p95/p99 time-to-presigned-URL (submit -> completed -> manifest
// URL available) against the 5s single SLA, renders/sec, and worker memory
// sampled at 1 Hz (peak + steady/median). Emits a markdown row for
// docs/measurements.md.
//
//   node scenarios/stress_burst.js
// env: PDF_API, PROVENANCE (e.g. container-2GB), MEM_CMD (see lib/util.js),
//      BURST_COUNT (50), BURST_WINDOW_MS (5000), SLA_MS (5000)

const {
  percentile, loadDoc, timeToUrl, startMemSampler, mdRow, today, sleep, PROVENANCE,
} = require('./lib/util');

const COUNT = parseInt(process.env.BURST_COUNT || '50', 10);
const WINDOW_MS = parseInt(process.env.BURST_WINDOW_MS || '5000', 10);
const SLA_MS = parseInt(process.env.SLA_MS || '5000', 10);

async function main() {
  console.log(`\nstress_burst: ${COUNT} singles over ${WINDOW_MS}ms (SLA ${SLA_MS}ms) [${PROVENANCE}]\n`);
  const sampler = startMemSampler({});
  const gap = WINDOW_MS / COUNT;
  const runId = Date.now().toString(36);

  const t0 = Date.now();
  const inflight = [];
  for (let i = 0; i < COUNT; i++) {
    inflight.push(
      timeToUrl(loadDoc(`BURST-${runId}-${i}`)).then((r) => {
        console.log(`  [${i}] ${r.ok ? 'ok' : `FAIL(${r.reason})`} ${r.ms}ms`);
        return r;
      })
    );
    await sleep(gap);
  }
  const results = await Promise.all(inflight);
  const wallMs = Date.now() - t0;
  const mem = sampler.stop();

  const okResults = results.filter((r) => r.ok);
  const lat = okResults.map((r) => r.ms).sort((a, b) => a - b);
  const failures = results.length - okResults.length;
  const misses = okResults.filter((r) => r.ms > SLA_MS).length + failures;
  const p50 = percentile(lat, 50), p95 = percentile(lat, 95), p99 = percentile(lat, 99);
  const rps = (okResults.length / (wallMs / 1000)).toFixed(2);

  console.log(`\nresults (${okResults.length}/${COUNT} ok, wall ${wallMs}ms):`);
  console.log(`  time-to-presigned-URL p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  console.log(`  SLA(${SLA_MS}ms) misses: ${misses}/${COUNT}`);
  console.log(`  renders/sec: ${rps}`);
  console.log(mem.available
    ? `  worker RSS: peak ${mem.peakMiB} MiB, steady ${mem.steadyMiB} MiB (${mem.count} samples @1Hz)`
    : `  worker RSS: sampler unavailable (${mem.failures} failed samples) — set MEM_CMD`);

  console.log('\nmeasurements.md row:');
  console.log(mdRow([
    today(),
    `stress_burst ${COUNT}/${WINDOW_MS / 1000}s`,
    `p50 ${p50} ms · p95 ${p95} ms · p99 ${p99} ms`,
    `SLA(${SLA_MS / 1000}s) misses ${misses}/${COUNT} · ${rps} renders/s · RSS peak ${mem.available ? mem.peakMiB : '?'} MiB / steady ${mem.available ? mem.steadyMiB : '?'} MiB · ${PROVENANCE}`,
  ]));

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error('stress_burst crashed:', e.message); process.exit(1); });
