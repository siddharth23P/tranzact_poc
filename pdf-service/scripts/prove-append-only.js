'use strict';

// Runtime proof that the append-only guarantee is enforced through the
// application's OWN code paths and pools — not just that the role exists.
//
// It:
//   1. Seeds a job row via the app pool (role pdf_app).
//   2. Appends a manifest row via src/manifest.js (role manifest_writer) — OK.
//   3. Attempts an UPDATE through that SAME restricted pool — must be DENIED.
//   4. Attempts a manifest INSERT through the app pool (pdf_app) — must be
//      DENIED (the app path cannot write the ledger at all).
//
// Run against a database that has already been migrated:
//   node scripts/prove-append-only.js
//
// Exits non-zero if any expectation fails.

const crypto = require('crypto');
const db = require('../src/db');
const manifest = require('../src/manifest');

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
}

async function expectDenied(label, fn) {
  try {
    await fn();
    fail(`${label}: expected permission denied, but it SUCCEEDED`);
  } catch (err) {
    if (/permission denied/i.test(err.message)) {
      ok(`${label}: denied (${err.message.trim()})`);
    } else {
      fail(`${label}: failed with unexpected error: ${err.message}`);
    }
  }
}

async function main() {
  const jobId = crypto.randomUUID();
  console.log(`\nRuntime append-only proof (jobId=${jobId})`);

  // 1) Seed a job via the app pool (pdf_app). Proves the app role writes jobs.
  console.log('\n[1] app pool (pdf_app) writes jobs:');
  await db.appPool.query(
    `INSERT INTO jobs (id, status, priority, total_documents) VALUES ($1,'processing','single',1)`,
    [jobId]
  );
  ok('pdf_app INSERT into jobs succeeded');

  // 2) Append a manifest row via the app's manifest module (manifest_writer).
  console.log('\n[2] manifest module (manifest_writer pool) appends ledger row:');
  const sha = crypto.createHash('sha256').update('demo-artifact').digest('hex');
  const entry = await manifest.appendRendered({
    jobId,
    documentIndex: 0,
    documentId: 'PO-DEMO-1',
    artifactKey: `artifacts/${jobId}/0.pdf`,
    sha256: sha,
    byteSize: 1234,
  });
  ok(`manifest_writer INSERT succeeded (entry id=${entry.id})`);

  // 3) Try to UPDATE the ledger through the SAME restricted pool → must deny.
  console.log('\n[3] same restricted pool attempts UPDATE:');
  await expectDenied('manifest_writer UPDATE', () =>
    db.getManifestPool().query(
      `UPDATE manifest_entries SET status='error' WHERE job_id=$1`,
      [jobId]
    )
  );
  await expectDenied('manifest_writer DELETE', () =>
    db.getManifestPool().query(`DELETE FROM manifest_entries WHERE job_id=$1`, [jobId])
  );

  // 4) The app pool (pdf_app) must NOT be able to write the ledger at all.
  console.log('\n[4] app pool (pdf_app) attempts to write the ledger:');
  await expectDenied('pdf_app INSERT manifest', () =>
    db.appPool.query(
      `INSERT INTO manifest_entries (job_id, document_index, status, sha256)
       VALUES ($1, 1, 'rendered', 'deadbeef')`,
      [jobId]
    )
  );

  // Confirm the original row is intact and readable.
  const rows = await manifest.listForJob(jobId);
  console.log(`\n[5] ledger state for job: ${rows.length} row(s)`);
  for (const r of rows) {
    console.log(`    idx=${r.document_index} status=${r.status} sha256=${(r.sha256 || '').slice(0, 12)}...`);
  }
  if (rows.length === 1 && rows[0].status === 'rendered') {
    ok('ledger unchanged: exactly one rendered row, no mutation got through');
  } else {
    fail(`unexpected ledger state: ${JSON.stringify(rows)}`);
  }

  await db.close();
  console.log(
    process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (append-only enforced at runtime)\n'
  );
}

main().catch(async (err) => {
  console.error('proof crashed:', err.message);
  process.exitCode = 1;
  try {
    await db.close();
  } catch (_) {
    /* ignore */
  }
});
