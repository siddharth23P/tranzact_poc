'use strict';

// Clarification 2 — template injection is inert.
//
// Template mechanism: JavaScript TEMPLATE LITERALS in src/render/template.js.
// Interpolation (`${...}`) is evaluated ONCE, at author time, over the template
// source — never over runtime user strings. User values only enter as the
// RESULT of escapeHtml(value), i.e. as ordinary string data concatenated into
// the HTML. There is no `{{ }}` templating engine and no eval/Function over user
// input. Therefore user data containing `${payload}` or `{{payload}}` is just
// text: `${...}` is not re-interpolated, and `{{...}}` has no meaning.
//
// This proves it end-to-end: render user data containing both payloads and read
// back the BROWSER-PARSED innerText, asserting the payloads survive as literal
// text (not interpolated, not executed, not stripped as markup).
//
//   node scripts/prove-injection.js

const { BrowserPool } = require('../src/browserPool');
const { buildPurchaseOrderHtml } = require('../src/render/template');
const { injectionDoc } = require('../../scenarios/phase2/gen');

function ok(m) { console.log(`  ✓ ${m}`); }
function bad(m) { console.error(`  ✗ ${m}`); process.exitCode = 1; }

async function main() {
  const doc = injectionDoc();
  const html = buildPurchaseOrderHtml(doc);

  console.log('\nTemplate injection proof (mechanism: JS template literals + escapeHtml)\n');

  // Static: the raw HTML must contain the payloads as literal text, and must
  // NOT contain an interpolated/evaluated result.
  const literalCurly = html.includes('{{payload}}');
  const literalDollar = html.includes('${payload}');
  literalCurly ? ok('HTML contains literal {{payload}}') : bad('{{payload}} missing/altered in HTML');
  literalDollar ? ok('HTML contains literal ${payload}') : bad('${payload} missing/altered in HTML');
  // The eval-shaped payload must appear as text, not its evaluation (which would
  // be "1"). We assert the literal source string is present.
  html.includes('${constructor.constructor(')
    ? ok('eval-shaped payload present as literal text (not evaluated)')
    : bad('eval-shaped payload altered');

  // End-to-end: parse in a real browser and read innerText.
  const pool = new BrowserPool({ size: 1 });
  await pool.start();
  const page = await pool.acquire('single');
  await page.setContent(html, { waitUntil: 'load' });
  const innerText = await page.evaluate(() => document.body.innerText);
  await pool.release(page, 'single');
  await pool.close();

  innerText.includes('{{payload}}')
    ? ok('browser innerText shows literal {{payload}}')
    : bad('{{payload}} not literal in rendered text');
  innerText.includes('${payload}')
    ? ok('browser innerText shows literal ${payload}')
    : bad('${payload} not literal in rendered text');

  console.log(process.exitCode ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED (payloads render as literal text)\n');
}

main().catch((e) => { console.error('crashed:', e.message); process.exitCode = 1; });
