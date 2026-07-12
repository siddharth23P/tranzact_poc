'use strict';

// Phase-5 review defect — no silent truncation.
//
//   (a) A 10KB description is REJECTED at enqueue-time validation with a clear
//       per-document error (never rendered, never clipped).
//   (b) A description at exactly the max validated length (110) renders FULLY:
//       the complete string appears in the sealed PDF's extracted text
//       (wrapped across lines, nothing ellipsized).
//
//   CHROMIUM_PATH=/path/to/chromium node scripts/prove-no-truncation.js

const { validateJobRequest, LIMITS } = require('../src/validation');
const { BrowserPool } = require('../src/browserPool');
const singlePass = require('../src/render/singlePass');
const { payloads } = require('../../scenarios/phase2/gen');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function extractAllText(pdfBuffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
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
  console.log(`\nNo-truncation proof (LIMITS.description=${LIMITS.description})\n`);

  // (a) 10KB description rejected at validation.
  const over = validateJobRequest(payloads.oversize_description);
  const overLen = payloads.oversize_description.documents[0].lineItems[0].description.length;
  if (!over.valid && over.documentErrors.length === 1) {
    const msg = over.documentErrors[0].errors.join('; ');
    /exceeds max length/.test(msg)
      ? ok(`10KB (${overLen} chars) description rejected: "${msg}"`)
      : bad(`rejected but with unexpected error: ${msg}`);
  } else {
    bad('oversize_description was NOT rejected by validation');
  }

  // (b) near-limit description passes validation…
  const near = validateJobRequest(payloads.near_limit_description);
  const desc = payloads.near_limit_description.documents[0].lineItems[0].description;
  near.valid
    ? ok(`near-limit description (${desc.length} chars) passes validation`)
    : bad(`near-limit rejected: ${JSON.stringify(near.documentErrors)}`);

  // …and renders FULLY.
  const pool = new BrowserPool({ size: 1 });
  await pool.start();
  const page = await pool.acquire('single');
  const pdf = await singlePass.render(page, payloads.near_limit_description.documents[0]);
  await pool.release(page, 'single');
  await pool.close();

  const text = await extractAllText(pdf);
  // Wrapping inserts breaks, so compare with all whitespace stripped.
  const strippedText = text.replace(/\s+/g, '');
  const strippedDesc = desc.replace(/\s+/g, '');
  strippedText.includes(strippedDesc)
    ? ok(`full ${desc.length}-char description present in the PDF (wrapped, not clipped)`)
    : bad('description is NOT fully present in the rendered PDF');

  // Explicitly assert the tail survived (the part clipping would eat).
  strippedText.includes(strippedDesc.slice(-30))
    ? ok(`description tail "…${desc.slice(-15)}" present`)
    : bad('description tail missing — truncation!');

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (no truncation)\n');
}

main().catch((e) => { console.error('crashed:', e.message); process.exitCode = 1; });
