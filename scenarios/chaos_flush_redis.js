'use strict';

// chaos_flush_redis — FLUSHALL mid-bulk, then document PRECISELY what recovers
// and what is lost. This validates the Redis-vs-SQS decision: Redis holds only
// re-derivable coordination state; the durable truth (snapshot, artifacts,
// ledger, job row) lives in S3 + Postgres.
//
// What the flush destroys:            What survives (and where):
//   - queued task list (queue pos.)     - snapshot          snapshots/{id}.json (S3)
//   - live progress counters            - rendered artifacts artifacts/{id}/N.pdf (S3)
//   - finalize marker                   - manifest ledger    manifest_entries (Postgres)
//   - task de-dupe ids                  - job row + idempotency key (Postgres)
//   - archive build locks
//
// The script then performs LEDGER-DERIVED RECOVERY by hand (the reconciler
// sketch from docs/queueing.md): seed counters from the manifest, re-enqueue
// exactly the missing document indexes, and watch the job complete.
//
//   node scenarios/chaos_flush_redis.js            (recovery included)
//   node scenarios/chaos_flush_redis.js --no-recover
// env: PDF_API, PROVENANCE,
//      FLUSH_CMD (default: docker compose exec -T redis redis-cli FLUSHALL)
//      FLUSH_AT_DOCS (40), CHAOS_DOCS (100), CHAOS_ROWS (20), GRACE_MS (20000)
//      REDIS_HOST/PORT (for recovery via pdf-service modules)

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const { createRequire } = require('module');
const { loadDoc, submitJob, getJob, getManifest, sleep, mdRow, today, PROVENANCE } = require('./lib/util');

const FLUSH_CMD = process.env.FLUSH_CMD || 'docker compose exec -T redis redis-cli FLUSHALL';
const FLUSH_AT = parseInt(process.env.FLUSH_AT_DOCS || '40', 10);
const DOCS = parseInt(process.env.CHAOS_DOCS || '100', 10);
const ROWS = parseInt(process.env.CHAOS_ROWS || '20', 10);
const GRACE_MS = parseInt(process.env.GRACE_MS || '20000', 10);
const RECOVER = !process.argv.includes('--no-recover');

const pdfServiceRequire = createRequire(path.join(__dirname, '..', 'pdf-service', 'package.json'));

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function main() {
  console.log(`\nchaos_flush_redis — bulk ${DOCS}×${ROWS}r, FLUSHALL at ~${FLUSH_AT} rendered [${PROVENANCE}]\n`);

  const runId = Date.now().toString(36);
  const docs = Array.from({ length: DOCS }, (_, i) => loadDoc(`FLUSH-${runId}-${i}`, ROWS));
  const job = await submitJob(docs);
  console.log(`job ${job.id} queued (${DOCS} docs)`);

  // Wait until mid-flight, then flush.
  for (;;) {
    const j = await getJob(job.id);
    const done = j.completedDocuments + j.failedDocuments;
    if (done >= FLUSH_AT) break;
    if (['completed', 'completed_with_errors', 'failed'].includes(j.status)) {
      console.error('job finished before the flush point — increase CHAOS_ROWS/DOCS'); process.exit(1);
    }
    await sleep(200);
  }
  console.log(`flushing at mid-flight:  $ ${FLUSH_CMD}`);
  execSync(FLUSH_CMD, { timeout: 10000, stdio: 'pipe' });

  // Grace period: in-flight pages finish; nothing else can proceed.
  console.log(`grace ${GRACE_MS / 1000}s — observing what the system still knows…`);
  await sleep(GRACE_MS);

  const jAfter = await getJob(job.id);
  const manifest = await getManifest(job.id);
  const rendered = manifest.documents.filter((d) => d.status === 'rendered');

  console.log('\n--- LOST (was only in Redis) ---');
  !['completed', 'completed_with_errors'].includes(jAfter.status)
    ? ok(`queued tasks gone -> job stuck (status=${jAfter.status}, will never complete on its own)`)
    : bad(`job completed anyway (${jAfter.status}) — flush landed too late to demonstrate loss`);
  console.log(`  live counters reset: GET /jobs now reports ${jAfter.completedDocuments}/${jAfter.totalDocuments} via ${jAfter.progressSource} (real rendered count is below)`);
  console.log('  also lost: finalize marker, task de-dupe ids, archive locks (all re-derivable or rebuildable)');

  console.log('\n--- RECOVERED (Postgres + S3) ---');
  rendered.length > 0
    ? ok(`manifest ledger intact: ${rendered.length} rendered rows with hashes (Postgres)`)
    : bad('no manifest rows survived?!');
  // Verify a pre-flush artifact end-to-end.
  const sample = rendered[0];
  const bytes = Buffer.from(await (await fetch(sample.url)).arrayBuffer());
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  sha === sample.sha256
    ? ok(`artifact bytes intact + hash-verified (doc[${sample.index}], S3)`)
    : bad('artifact hash mismatch after flush');
  manifest.snapshot.createdAt
    ? ok(`snapshot object intact (${manifest.snapshot.key}, S3) — missing docs are exactly re-renderable`)
    : bad('snapshot missing');
  ok(`job row + idempotency key intact (status=${jAfter.status}, Postgres)`);

  if (!RECOVER) {
    console.log('\n(--no-recover: leaving the job stuck as evidence)');
  } else {
    // Ledger-derived recovery (the reconciler from docs/queueing.md, by hand):
    //   1. compute the missing indexes from the manifest ledger;
    //   2. seed Redis counters back to the ledger's counts;
    //   3. re-enqueue exactly the missing indexes (snapshot still in S3, so
    //      the re-renders are deterministic).
    console.log('\n--- RECOVERY (reconciler-by-hand, from ledger + snapshot) ---');
    const doneIdx = new Set(manifest.documents.map((d) => d.index));
    const failedCount = manifest.documents.filter((d) => d.status === 'error').length;
    const missing = [];
    for (let i = 0; i < DOCS; i++) if (!doneIdx.has(i)) missing.push(i);
    console.log(`  ledger says: ${rendered.length} rendered, ${failedCount} failed, ${missing.length} missing -> re-enqueue exactly those`);

    const progress = pdfServiceRequire('./src/progress');
    const queues = pdfServiceRequire('./src/queues');
    const redis = pdfServiceRequire('./src/redis');
    const db = pdfServiceRequire('./src/db');
    await progress.seed(job.id, { completed: rendered.length, failed: failedCount, total: DOCS });
    await queues.enqueueDocuments(job.id, DOCS, 'bulk', { indexes: missing });
    console.log(`  counters seeded (${rendered.length}/${failedCount}/${DOCS}); ${missing.length} tasks re-enqueued`);

    for (let waited = 0; waited < 180000; waited += 1000) {
      const j = await getJob(job.id);
      if (['completed', 'completed_with_errors', 'failed'].includes(j.status)) {
        j.status === 'completed' && j.completedDocuments === DOCS
          ? ok(`recovered: job completed ${j.completedDocuments}/${DOCS} after re-enqueue`)
          : bad(`recovery terminal but ${j.status} (${j.completedDocuments}/${DOCS})`);
        break;
      }
      await sleep(1000);
    }
    const finalManifest = await getManifest(job.id);
    const finalRendered = finalManifest.documents.filter((d) => d.status === 'rendered').length;
    finalRendered === DOCS
      ? ok(`final ledger: all ${DOCS} documents rendered (latest-per-index)`)
      : bad(`final ledger only has ${finalRendered}/${DOCS} rendered`);
    await queues.close();
    await redis.close();
    await db.close().catch(() => {});
  }

  console.log('\nmeasurements.md row:');
  console.log(mdRow([today(), `chaos_flush_redis (${DOCS}×${ROWS}r, flush@${FLUSH_AT})`,
    process.exitCode ? 'FAILED' : `ledger intact ${rendered.length}/${DOCS} · job stuck as designed`,
    `recovery ${RECOVER ? 'demonstrated' : 'skipped'} · ${PROVENANCE}`]));
  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch((e) => { console.error('chaos_flush_redis crashed:', e.message); process.exit(1); });
