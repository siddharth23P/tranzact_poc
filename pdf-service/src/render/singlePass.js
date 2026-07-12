'use strict';

// SinglePass render strategy: build the full HTML for a document and print it
// to a single PDF in one pass. This is the default strategy; ChunkedMerge
// (phase 4) handles documents whose line-item count exceeds a threshold.

const { buildPurchaseOrderHtml } = require('./template');

// Render one document to a PDF Buffer using a pooled page.
async function render(page, doc) {
  const html = buildPurchaseOrderHtml(doc);
  // `networkidle0` isn't needed — the template is fully self-contained (no
  // external fonts/images), so `load` is sufficient and faster.
  await page.setContent(html, { waitUntil: 'load' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
  // page.pdf returns a Uint8Array in newer puppeteer; normalize to Buffer.
  return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
}

module.exports = { render, name: 'SinglePass' };
