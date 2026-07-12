'use strict';

// Download client (the "MEGA-style" client-side assembly path):
//   1. polls GET /jobs/{id} until terminal, printing live progress;
//   2. fetches GET /jobs/{id}/manifest;
//   3. downloads every rendered file through its presigned URL with a
//      concurrency pool (default 4) and per-file retry (default 2 retries,
//      backoff), verifying EVERY sha256 against the manifest;
//   4. reports progress per file and a final summary; exits non-zero on any
//      failure or hash mismatch.
//
//   node scenarios/client/download.js <jobId> [outDir]
//   env: PDF_API (default http://localhost:3000), CONCURRENCY (4), RETRIES (2)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PDF_API = process.env.PDF_API || 'http://localhost:3000';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const RETRIES = parseInt(process.env.RETRIES || '2', 10);

async function pollUntilTerminal(jobId, { quiet = false } = {}) {
  const TERMINAL = ['completed', 'completed_with_errors', 'failed'];
  for (;;) {
    const res = await fetch(`${PDF_API}/jobs/${jobId}`);
    if (!res.ok) throw new Error(`GET /jobs/${jobId} -> ${res.status}`);
    const job = await res.json();
    if (!quiet) {
      console.log(
        `  status=${job.status} progress=${job.completedDocuments + job.failedDocuments}/${job.totalDocuments}` +
        ` (ok=${job.completedDocuments} failed=${job.failedDocuments}, source=${job.progressSource})`
      );
    }
    if (TERMINAL.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function fetchManifest(jobId) {
  const res = await fetch(`${PDF_API}/jobs/${jobId}/manifest`);
  if (!res.ok) throw new Error(`manifest -> ${res.status}`);
  return res.json();
}

async function downloadOne(doc, outDir, attempt = 0) {
  try {
    const res = await fetch(doc.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== doc.sha256) throw new Error(`sha256 mismatch (got ${sha.slice(0, 12)}…, want ${doc.sha256.slice(0, 12)}…)`);
    const file = path.join(outDir, `${String(doc.index).padStart(3, '0')}_${doc.documentId}.pdf`);
    fs.writeFileSync(file, bytes);
    return { ok: true, bytes: bytes.length, attempts: attempt + 1 };
  } catch (err) {
    if (attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      return downloadOne(doc, outDir, attempt + 1);
    }
    return { ok: false, error: err.message, attempts: attempt + 1 };
  }
}

// Fixed-size worker pool over the rendered documents.
async function downloadAll(manifest, outDir) {
  const rendered = manifest.documents.filter((d) => d.status === 'rendered');
  const queue = [...rendered];
  const results = [];
  let done = 0;

  async function worker() {
    for (;;) {
      const doc = queue.shift();
      if (!doc) return;
      const r = await downloadOne(doc, outDir);
      done += 1;
      results.push({ doc, ...r });
      const kb = r.ok ? `${(r.bytes / 1024).toFixed(1)} KB` : `FAILED: ${r.error}`;
      const retryNote = r.attempts > 1 ? ` [${r.attempts} attempts]` : '';
      console.log(`  [${done}/${rendered.length}] ${r.ok ? 'verified' : 'ERROR'} ${String(doc.index).padStart(3, '0')}_${doc.documentId}.pdf (${kb})${retryNote}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rendered.length || 1) }, worker));
  return { rendered, results };
}

async function run(jobId, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\nDownload client: job ${jobId} -> ${outDir} (pool=${CONCURRENCY}, retries=${RETRIES})\n`);

  console.log('polling until terminal:');
  const job = await pollUntilTerminal(jobId);

  const manifest = await fetchManifest(jobId);
  const errorDocs = manifest.documents.filter((d) => d.status === 'error');
  console.log(`\nmanifest: ${manifest.counts.rendered} rendered, ${manifest.counts.failed} failed, urls expire ${manifest.urlsExpireAt}\n`);

  const { rendered, results } = await downloadAll(manifest, outDir);
  const failed = results.filter((r) => !r.ok);

  console.log(`\nsummary: ${results.length - failed.length}/${rendered.length} downloaded+verified, ${failed.length} failed, ${errorDocs.length} render-errors`);
  for (const d of errorDocs) console.log(`  render-error doc[${d.index}] ${d.documentId}: ${d.error}`);
  for (const f of failed) console.log(`  download-failure doc[${f.doc.index}] ${f.doc.documentId}: ${f.error}`);

  const ok = failed.length === 0;
  console.log(ok ? '\nRESULT: PASSED (all hashes verified)\n' : '\nRESULT: FAILED\n');
  return { ok, job, manifest, results };
}

module.exports = { run, pollUntilTerminal, fetchManifest };

if (require.main === module) {
  const [jobId, outDir] = process.argv.slice(2);
  if (!jobId) { console.error('usage: download.js <jobId> [outDir]'); process.exit(2); }
  run(jobId, outDir || `/tmp/pdf-dl/${jobId}`)
    .then(({ ok }) => process.exit(ok ? 0 : 1))
    .catch((e) => { console.error('download client crashed:', e.message); process.exit(1); });
}
