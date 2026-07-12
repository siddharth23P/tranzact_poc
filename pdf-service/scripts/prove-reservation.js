'use strict';

// Clarification 1 — the single-lane reservation is STRUCTURAL, enforced by the
// BrowserPool on acquire (bulk granted only while bulkInFlight < N-k), not by
// worker concurrency convention.
//
// With N=3, k=1 (bulkCap=2): saturate the bulk lane and show that (a) bulk never
// exceeds 2 in-flight even when 3 bulk tasks ask, and (b) a single task still
// gets a page immediately under that bulk pressure.
//
//   CHROMIUM_PATH=/path/to/chromium node scripts/prove-reservation.js

const { BrowserPool } = require('../src/browserPool');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }
const settled = (p) => Promise.race([p.then(() => true), Promise.resolve().then(() => false)]);

async function main() {
  console.log('\nReservation invariant proof (N=3, k=1 -> bulkCap=2)\n');
  const pool = new BrowserPool({ size: 3, reserved: 1 });
  await pool.start();

  // Three bulk acquires — only two may be granted.
  const b1 = pool.acquire('bulk');
  const b2 = pool.acquire('bulk');
  const b3 = pool.acquire('bulk');
  await new Promise((r) => setImmediate(r));

  const [b1ok, b2ok, b3ok] = await Promise.all([settled(b1), settled(b2), settled(b3)]);
  b1ok && b2ok ? ok('first two bulk acquires granted') : bad('expected 2 bulk grants');
  !b3ok ? ok('third bulk acquire BLOCKED (bulkInFlight capped at N-k=2)') : bad('3rd bulk was granted — cap breached');

  let s = pool.stats();
  console.log(`  stats: ${JSON.stringify(s)}`);
  s.bulkInFlight === 2 ? ok('bulkInFlight === 2') : bad(`bulkInFlight=${s.bulkInFlight}`);
  s.idle === 1 ? ok('1 page still idle = reserved for single') : bad(`idle=${s.idle}`);

  // A single task must get that reserved page immediately, despite bulk pressure.
  const single = pool.acquire('single');
  await new Promise((r) => setImmediate(r));
  (await settled(single))
    ? ok('single acquire granted immediately under bulk saturation (reserved page)')
    : bad('single task blocked behind bulk — reservation failed');

  // Release a bulk page; the blocked bulk#3 should now proceed.
  const bp2 = await b2;
  await pool.release(bp2, 'bulk');
  await new Promise((r) => setImmediate(r));
  (await settled(b3))
    ? ok('after a bulk release, blocked bulk#3 proceeds (bulkInFlight back under cap)')
    : bad('bulk#3 still blocked after release');

  await pool.close();
  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (reservation enforced structurally)\n');
}

main().catch((e) => { console.error('crashed:', e.message); process.exitCode = 1; });
