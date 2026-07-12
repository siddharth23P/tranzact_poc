'use strict';

// Phase-4 review item 1 — strategy equivalence proof.
//
// Renders the SAME 600-row purchase order twice: forced SinglePass and forced
// ChunkedMerge. Prints bytes/pages/duration for both and asserts:
//   - equal page counts;
//   - identical line-number ranges — proved in the strongest form: the
//     extracted text of every page is IDENTICAL between the two strategies
//     (same rows on the same pages), plus explicit first/last row checks;
//   - "Total" appears exactly once in each document;
//   - the table header renders at the top of EVERY page (review item 3);
//   - the "Page X of Y" footer is present and continuous in BOTH documents
//     (both strategies share src/render/stamp.js — see phase-4 docs).
//
//   CHROMIUM_PATH=/path/to/chromium node scripts/prove-equivalence.js

const config = require('../src/config');
const { BrowserPool } = require('../src/browserPool');
const singlePass = require('../src/render/singlePass');
const chunkedMerge = require('../src/render/chunkedMerge');
const { purchaseOrder } = require('../../scenarios/phase2/gen');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function extractPageTexts(pdfBuffer) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  const texts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  return texts;
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { result, ms };
}

async function main() {
  const ROWS = 600;
  // descPad: 100-char descriptions -> every row wraps to multiple lines, so the
  // equivalence holds for the fixed-height wrapped-row layout, not just
  // single-line rows.
  const doc = purchaseOrder(0, ROWS, { descPad: 100 });
  console.log(`\nEquivalence proof: ${ROWS}-row PO (wrapped multi-line rows), SinglePass vs ChunkedMerge`);
  console.log(`  config: ROWS_PER_PAGE=${config.render.rowsPerPage} CHUNK_SIZE=${config.render.chunkSize}\n`);

  const pool = new BrowserPool({ size: 1 });
  await pool.start();
  const page = await pool.acquire('single');

  const sp = await timed(() => singlePass.render(page, doc));
  const cm = await timed(() => chunkedMerge.render(page, doc, { chunkSize: config.render.chunkSize }));

  await pool.release(page, 'single');
  await pool.close();

  const spPages = await extractPageTexts(sp.result);
  const cmPages = await extractPageTexts(cm.result);

  console.log(`  SinglePass : ${sp.result.length} bytes, ${spPages.length} pages, ${sp.ms.toFixed(0)} ms`);
  console.log(`  ChunkedMerge: ${cm.result.length} bytes, ${cmPages.length} pages, ${cm.ms.toFixed(0)} ms\n`);

  // 1) Equal page counts.
  spPages.length === cmPages.length
    ? ok(`equal page counts (${spPages.length})`)
    : bad(`page counts differ: SinglePass=${spPages.length} ChunkedMerge=${cmPages.length}`);

  // 2) Identical per-page text (covers line-number ranges page-for-page).
  let identical = true;
  const n = Math.min(spPages.length, cmPages.length);
  for (let i = 0; i < n; i++) {
    if (spPages[i] !== cmPages[i]) {
      identical = false;
      bad(`page ${i + 1} text differs`);
      console.error(`    SP: …${spPages[i].slice(0, 120)}…`);
      console.error(`    CM: …${cmPages[i].slice(0, 120)}…`);
      break;
    }
  }
  if (identical && spPages.length === cmPages.length) ok('every page text-identical between strategies');

  // Explicit range checks: row 1 on page 1, row 600 on the last page, in both.
  for (const [name, pages] of [['SinglePass', spPages], ['ChunkedMerge', cmPages]]) {
    /(^|\s)1\s/.test(pages[0]) ? ok(`${name}: row 1 on page 1`) : bad(`${name}: row 1 missing from page 1`);
    new RegExp(`(^|\\s)${ROWS}(\\s|$)`).test(pages[pages.length - 1])
      ? ok(`${name}: row ${ROWS} on last page`)
      : bad(`${name}: row ${ROWS} missing from last page`);
  }

  // 3) "Total" exactly once in each.
  for (const [name, pages] of [['SinglePass', spPages], ['ChunkedMerge', cmPages]]) {
    const count = pages.join(' ').match(/\bTotal\b/g)?.length ?? 0;
    count === 1 ? ok(`${name}: "Total" appears exactly once`) : bad(`${name}: "Total" appears ${count} times`);
  }

  // 4) Table header on EVERY page (review item 3).
  for (const [name, pages] of [['SinglePass', spPages], ['ChunkedMerge', cmPages]]) {
    // th text is CSS-uppercased, so the PDF glyphs are "DESCRIPTION"/"UNIT PRICE".
    const missing = pages
      .map((t, i) => (/DESCRIPTION/i.test(t) && /UNIT\s*PRICE/i.test(t) ? null : i + 1))
      .filter(Boolean);
    missing.length === 0
      ? ok(`${name}: table header present on all ${pages.length} pages`)
      : bad(`${name}: header missing on pages ${missing.join(',')}`);
  }

  // 5) Footer continuity in both.
  for (const [name, pages] of [['SinglePass', spPages], ['ChunkedMerge', cmPages]]) {
    const N = pages.length;
    const broken = pages.map((t, i) => (t.includes(`Page ${i + 1} of ${N}`) ? null : i + 1)).filter(Boolean);
    broken.length === 0
      ? ok(`${name}: continuous footers "Page 1 of ${N}" … "Page ${N} of ${N}"`)
      : bad(`${name}: footer wrong on pages ${broken.join(',')}`);
  }

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (strategies equivalent)\n');
}

main().catch((e) => { console.error('crashed:', e.message); process.exitCode = 1; });
