'use strict';

// STALE-DATA PROOF — the bulk-consistency guarantee, exercised for real.
//
//   1. Trigger a bulk job of 100 purchase orders from mock-erp (the full
//      payload is snapshotted to S3 at enqueue).
//   2. At t+5s — mid-render — PUT-mutate document #87's SOURCE entity in the
//      ERP (vendor name + first line-item description).
//   3. When the job completes, download #87's sealed PDF via the manifest and
//      assert its text matches the SNAPSHOT values, not the mutation.
//      Both values are printed.
//
// Requires: mock-erp (seeded), api, worker all running.
//   node scenarios/stale-data/run.js
// env: MOCK_ERP_URL, PDF_API, TARGET_INDEX (87), MUTATE_AT_MS (5000)

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const { triggerBulk } = require('../client/trigger');
const { pollUntilTerminal, fetchManifest } = require('../client/download');

const MOCK_ERP_URL = process.env.MOCK_ERP_URL || 'http://localhost:4000';
const TARGET_INDEX = parseInt(process.env.TARGET_INDEX || '87', 10);
// Default 2000ms, not 5000: this rig renders ~20 docs/s, so doc #87 renders at
// ~t+4.4s — the mutation must land strictly BEFORE that for the proof to be
// conclusive (the script asserts the ordering via the manifest's renderedAt).
const MUTATE_AT_MS = parseInt(process.env.MUTATE_AT_MS || '2000', 10);
const BULK_SIZE = 100;

// pdfjs lives in pdf-service's node_modules; resolve through its package.
const pdfServiceRequire = createRequire(path.join(__dirname, '..', '..', 'pdf-service', 'package.json'));

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }
const strip = (s) => String(s).replace(/\s+/g, '');

async function extractAllText(pdfBuffer) {
  const pdfjs = pdfServiceRequire('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str).join(' ') + ' ';
  }
  return out;
}

async function main() {
  console.log(`\nSTALE-DATA PROOF: bulk of ${BULK_SIZE}, mutate doc #${TARGET_INDEX} at t+${MUTATE_AT_MS}ms\n`);

  // 0. Reset the target entity to a KNOWN baseline so the proof is
  // self-contained and rerunnable (a previous run's mutation must not leak
  // into this run's snapshot).
  const BASELINE_VENDOR = 'Baseline Steel Works & Co';
  const BASELINE_DESC = 'BASELINE-SNAPSHOT-VALUE zinc-coated bracket 40mm';
  const targetIdList = await (await fetch(`${MOCK_ERP_URL}/purchase-orders?limit=${BULK_SIZE}`)).json();
  const targetId = targetIdList.items[TARGET_INDEX].id;
  const baseEntity = targetIdList.items[TARGET_INDEX];
  const resetRes = await fetch(`${MOCK_ERP_URL}/purchase-orders/${targetId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vendor: { ...baseEntity.vendor, name: BASELINE_VENDOR },
      lineItems: [
        { ...baseEntity.lineItems[0], description: BASELINE_DESC },
        ...baseEntity.lineItems.slice(1),
      ],
    }),
  });
  if (!resetRes.ok) throw new Error(`baseline reset PUT failed: ${resetRes.status}`);
  console.log(`baseline reset: ${targetId} vendor/desc set to known values\n`);

  // 1. Trigger the bulk job (payload snapshotted at enqueue).
  const t0 = Date.now();
  const { job, entities } = await triggerBulk(BULK_SIZE, `stale-proof-${crypto.randomUUID()}`);
  const target = entities[TARGET_INDEX];
  const snapshotVendor = target.vendor.name;
  const snapshotDesc = target.lineItems[0].description;
  if (snapshotVendor !== BASELINE_VENDOR || snapshotDesc !== BASELINE_DESC) {
    throw new Error('snapshot does not reflect the baseline reset — aborting');
  }
  console.log(`job ${job.id} enqueued (${job.totalDocuments} docs) at t+${Date.now() - t0}ms`);
  console.log(`target: documents[${TARGET_INDEX}] = entity ${target.id}`);
  console.log(`  SNAPSHOT vendor.name              = ${JSON.stringify(snapshotVendor)}`);
  console.log(`  SNAPSHOT lineItems[0].description = ${JSON.stringify(snapshotDesc)}\n`);

  // 2. Mutate the source entity mid-render.
  const MUTATED_VENDOR = 'MUTATED VENDOR PVT LTD';
  const MUTATED_DESC = 'MUTATED-AFTER-SNAPSHOT this text must NOT appear in the PDF';
  await new Promise((r) => setTimeout(r, MUTATE_AT_MS));
  const putRes = await fetch(`${MOCK_ERP_URL}/purchase-orders/${target.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vendor: { ...target.vendor, name: MUTATED_VENDOR },
      lineItems: [{ ...target.lineItems[0], description: MUTATED_DESC }, ...target.lineItems.slice(1)],
    }),
  });
  if (!putRes.ok) throw new Error(`mutation PUT failed: ${putRes.status}`);
  const mutatedAt = Date.now();
  console.log(`mutated source entity ${target.id} at t+${mutatedAt - t0}ms (mid-render)`);
  console.log(`  LIVE vendor.name              -> ${JSON.stringify(MUTATED_VENDOR)}`);
  console.log(`  LIVE lineItems[0].description -> ${JSON.stringify(MUTATED_DESC)}\n`);

  // 3. Wait for completion; the render must have used the snapshot.
  console.log('waiting for job to complete:');
  const finalJob = await pollUntilTerminal(job.id);
  if (finalJob.status !== 'completed') {
    bad(`expected status=completed, got ${finalJob.status} (failed=${finalJob.failedDocuments})`);
  } else {
    ok(`job completed ${finalJob.completedDocuments}/${finalJob.totalDocuments} at t+${Date.now() - t0}ms`);
  }

  const manifest = await fetchManifest(job.id);
  const doc87 = manifest.documents.find((d) => d.index === TARGET_INDEX);
  if (!doc87 || doc87.status !== 'rendered') throw new Error(`doc #${TARGET_INDEX} not rendered: ${JSON.stringify(doc87)}`);

  // Ordering proof: #87 must have RENDERED AFTER the mutation landed —
  // otherwise even a live-data renderer would coincidentally show old values
  // and the run is inconclusive.
  const renderedAt = new Date(doc87.renderedAt).getTime();
  const gapMs = renderedAt - mutatedAt;
  if (gapMs > 0) {
    ok(`ordering conclusive: #87 rendered ${gapMs}ms AFTER the mutation (renderedAt=${doc87.renderedAt})`);
  } else {
    bad(`INCONCLUSIVE: #87 rendered ${-gapMs}ms BEFORE the mutation — lower MUTATE_AT_MS and re-run`);
  }

  const res = await fetch(doc87.url);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  sha === doc87.sha256 ? ok('downloaded #87, sha256 matches manifest') : bad('sha256 mismatch on #87');

  const text = await extractAllText(bytes);
  const sText = strip(text);

  console.log('\n--- verdict on the sealed PDF for doc #87 ---');
  console.log(`  live (mutated) source now says : vendor=${JSON.stringify(MUTATED_VENDOR)}, desc=${JSON.stringify(MUTATED_DESC)}`);
  console.log(`  snapshot said                  : vendor=${JSON.stringify(snapshotVendor)}, desc=${JSON.stringify(snapshotDesc)}`);

  sText.includes(strip(snapshotVendor))
    ? ok('PDF contains the SNAPSHOT vendor name')
    : bad('PDF is missing the snapshot vendor name');
  sText.includes(strip(snapshotDesc))
    ? ok('PDF contains the SNAPSHOT line-item description')
    : bad('PDF is missing the snapshot description');
  !sText.includes('MUTATED')
    ? ok('PDF contains NO mutated values (render used the frozen snapshot)')
    : bad('PDF CONTAINS MUTATED VALUES — stale-data guarantee broken!');

  // Confirm the mutation really landed in the ERP (the proof is meaningful).
  const live = await (await fetch(`${MOCK_ERP_URL}/purchase-orders/${target.id}`)).json();
  live.vendor.name === MUTATED_VENDOR
    ? ok('ERP source entity IS mutated (mutation landed; only the render ignored it)')
    : bad('mutation did not land in the ERP — proof inconclusive');

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (PDF matches snapshot, not live data)\n');
}

main().catch((e) => { console.error('stale-data proof crashed:', e.message); process.exitCode = 1; });
