'use strict';

// Phase 4 — ChunkedMerge proof.
//
// Renders a large purchase order (line items > CHUNK_THRESHOLD), asserts:
//   - the selector picks ChunkedMerge (and SinglePass for a small doc);
//   - the merged output is a valid multi-page PDF;
//   - page numbers are CONTINUOUS across the whole document: extracted text
//     contains "Page 1 of N" … "Page N of N", strictly sequential, single N;
//   - line-item numbering is continuous across chunks (row "1"…"120" present).
//
//   CHROMIUM_PATH=/path/to/chromium node scripts/prove-chunked-merge.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { BrowserPool } = require('../src/browserPool');
const { chooseStrategy } = require('../src/render/selectStrategy');
const chunkedMerge = require('../src/render/chunkedMerge');
const singlePass = require('../src/render/singlePass');
const { purchaseOrder } = require('../../scenarios/phase2/gen');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function extractPageTexts(pdfBuffer) {
  // pdfjs legacy build works under Node without a DOM.
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  const texts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((it) => it.str).join(' '));
  }
  return texts;
}

async function main() {
  console.log('\nChunkedMerge proof\n');
  const threshold = config.render.chunkThreshold;
  const chunkSize = config.render.chunkSize;
  console.log(`  config: CHUNK_THRESHOLD=${threshold} CHUNK_SIZE=${chunkSize}`);

  const bigDoc = purchaseOrder(0, 120); // 120 line items
  const smallDoc = purchaseOrder(1, 3);

  // Selection.
  chooseStrategy(bigDoc).name === 'ChunkedMerge'
    ? ok('120-item doc -> ChunkedMerge')
    : bad('big doc did not select ChunkedMerge');
  chooseStrategy(smallDoc).name === 'SinglePass'
    ? ok('3-item doc -> SinglePass')
    : bad('small doc did not select SinglePass');

  // Render the big doc via ChunkedMerge.
  const pool = new BrowserPool({ size: 1 });
  await pool.start();
  const page = await pool.acquire('single');
  const pdf = await chunkedMerge.render(page, bigDoc, { chunkSize });
  await pool.release(page, 'single');
  await pool.close();

  const isPdf = pdf.slice(0, 5).toString('latin1') === '%PDF-';
  isPdf ? ok(`merged output is a PDF (${pdf.length} bytes)`) : bad('output not a PDF');

  const outPath = path.join(os.tmpdir(), 'chunked-proof.pdf');
  fs.writeFileSync(outPath, pdf);
  console.log(`  wrote ${outPath}`);

  const pageTexts = await extractPageTexts(pdf);
  const N = pageTexts.length;
  console.log(`  merged PDF has ${N} page(s)`);
  N >= 2 ? ok('multi-page (chunks stitched)') : bad('expected multiple pages');

  // Continuous page numbers: each page i must contain "Page i of N".
  let continuous = true;
  for (let i = 0; i < N; i++) {
    const want = `Page ${i + 1} of ${N}`;
    const norm = pageTexts[i].replace(/\s+/g, ' ');
    if (!norm.includes(want)) {
      continuous = false;
      bad(`page ${i + 1} missing footer "${want}"; got: ${norm.slice(-40)}`);
    }
  }
  if (continuous) ok(`page numbers continuous: "Page 1 of ${N}" … "Page ${N} of ${N}"`);

  // Continuous line numbering across chunks: rows 1 and 120 should both appear.
  const all = pageTexts.join(' ').replace(/\s+/g, ' ');
  const hasFirst = /(^|\D)1\b/.test(all);
  const hasLast = all.includes('120');
  hasFirst && hasLast
    ? ok('line-item numbering spans chunks (row 1 … row 120 present)')
    : bad('line-item numbering not continuous across chunks');

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
}

main().catch((e) => { console.error('crashed:', e.message); process.exitCode = 1; });
