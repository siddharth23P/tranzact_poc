'use strict';

// SinglePass render strategy: build the full (pre-paginated) HTML for a
// document and print it to a PDF in one Chromium pass, then stamp page numbers
// via the SAME shared stamp step ChunkedMerge uses — so both strategies produce
// identical "Page X of Y" footers by construction.

const config = require('../config');
const { buildPurchaseOrderHtml } = require('./template');
const { stampPageNumbers } = require('./stamp');

// Render one document to a PDF Buffer using a pooled page.
async function render(page, doc) {
  const html = buildPurchaseOrderHtml(doc, { rowsPerPage: config.render.rowsPerPage });
  // `networkidle0` isn't needed — the template is fully self-contained (no
  // external fonts/images), so `load` is sufficient and faster.
  await page.setContent(html, { waitUntil: 'load' });
  const pdf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
  // page.pdf returns a Uint8Array in newer puppeteer; normalize to Buffer.
  return stampPageNumbers(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf));
}

module.exports = { render, name: 'SinglePass' };
