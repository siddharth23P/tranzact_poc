'use strict';

// Phase-3 end-to-end smoke test: render ONE purchase order through the real
// pipeline and print the manifest row + presigned URL.
//
//   snapshot -> BrowserPool render -> SHA-256 -> S3 artifact -> manifest (via
//   manifest_writer) -> presigned URL
//
// Also re-downloads the stored PDF, re-hashes it, and asserts the bytes are a
// PDF whose SHA-256 matches the manifest — proving the seal is over the exact
// delivered bytes. Requires migrated local infra + Chromium.
//
//   node scripts/smoke-render.js

const crypto = require('crypto');
const db = require('./../src/db');
const s3 = require('./../src/s3');
const progress = require('./../src/progress');
const manifest = require('./../src/manifest');
const redis = require('./../src/redis');
const { BrowserPool } = require('./../src/browserPool');
const { renderDocument } = require('./../src/render/pipeline');

async function cleanup() {
  try { await redis.close(); } catch (_) {}
  try { await db.close(); } catch (_) {}
}

function line(m) { console.log(m); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }
function ok(m) { console.log(`  ✓ ${m}`); }

const sampleDoc = {
  documentId: 'PO-SMOKE-1',
  type: 'purchase_order',
  poNumber: 'PO-9001',
  vendor: { name: 'Acme Supplies <Ltd>', address: '1 Market St\nSpringfield' }, // note the < > to prove escaping
  buyer: { name: 'TranZact ERP', address: '500 Enterprise Way' },
  currency: 'USD',
  lineItems: [
    { description: 'Widget "A" & bracket', quantity: 3, unitPrice: 9.99 },
    { description: 'Gadget <deluxe>', quantity: 1, unitPrice: 25 },
  ],
};

async function main() {
  const jobId = crypto.randomUUID();
  line(`\nPhase-3 smoke render (jobId=${jobId})\n`);

  // Snapshot (workers render only from this).
  await s3.putSnapshot(jobId, { jobId, priority: 'single', documentCount: 1, documents: [sampleDoc] });
  ok('snapshot written to S3');

  // Job row + progress counters.
  await db.appPool.query(
    `INSERT INTO jobs (id, status, priority, total_documents) VALUES ($1,'processing','single',1)`,
    [jobId]
  );
  await progress.init(jobId, 1);

  // Render.
  const pool = new BrowserPool({ size: 1 });
  await pool.start();
  const started = process.hrtime.bigint();
  const result = await renderDocument({ pool, jobId, documentIndex: 0, doc: sampleDoc });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  await pool.close();

  if (result.status !== 'rendered') {
    bad(`render failed: ${result.error}`);
    await cleanup();
    return;
  }
  ok(`rendered in ${ms.toFixed(0)}ms`);

  // Finalize.
  const fin = await progress.claimFinalizeIfDone(jobId, 1);
  if (fin.done) await progress.flushToJobsRow(jobId, fin.completed > 0 ? 'completed' : 'failed');

  // Read back the manifest row (through the restricted pool's SELECT).
  const rows = await manifest.listForJob(jobId);
  const entry = rows[0];
  const url = await s3.presignGet(entry.artifact_key);

  line('\n--- manifest row ---');
  line(JSON.stringify({
    id: entry.id,
    job_id: entry.job_id,
    document_index: entry.document_index,
    document_id: entry.document_id,
    status: entry.status,
    artifact_key: entry.artifact_key,
    sha256: entry.sha256,
    byte_size: entry.byte_size,
    created_at: entry.created_at,
  }, null, 2));

  line('\n--- presigned URL ---');
  line(url);

  // Verify: re-download, re-hash, confirm PDF + hash match.
  line('\n--- integrity verification ---');
  const stored = await s3.client.send(
    new (require('@aws-sdk/client-s3').GetObjectCommand)({ Bucket: s3.BUCKET, Key: entry.artifact_key })
  );
  const bytes = Buffer.from(await stored.Body.transformToByteArray());
  const rehash = crypto.createHash('sha256').update(bytes).digest('hex');
  const isPdf = bytes.slice(0, 5).toString('latin1') === '%PDF-';
  isPdf ? ok('stored artifact is a PDF (%PDF- magic)') : bad('stored artifact is not a PDF');
  rehash === entry.sha256
    ? ok(`re-hash matches manifest sha256 (${rehash.slice(0, 16)}…)`)
    : bad(`hash mismatch: manifest=${entry.sha256} stored=${rehash}`);
  Number(entry.byte_size) === bytes.length
    ? ok(`byte_size matches (${bytes.length} bytes)`)
    : bad(`byte_size mismatch: manifest=${entry.byte_size} stored=${bytes.length}`);

  await cleanup();
  line(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch(async (err) => {
  console.error('smoke crashed:', err.message);
  process.exitCode = 1;
  await cleanup();
});
