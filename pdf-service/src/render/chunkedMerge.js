'use strict';

// ChunkedMerge render strategy: for documents with many line items, render the
// items in row-chunks (each via the SAME escaped, pre-paginated template) and
// stitch the chunk PDFs into one with pdf-lib. Chunks are rendered sequentially
// on the single task-held page (page-per-task still holds).
//
// Equivalence with SinglePass (proved by scripts/prove-equivalence.js):
//   - the template paginates into fixed-height sheets of `rowsPerPage` rows;
//   - the chunk size is snapped UP to a multiple of rowsPerPage, so chunk
//     boundaries always align with sheet boundaries;
//   => both strategies emit the identical sheet sequence: same page count,
//      same per-page content, continuous line numbers, total on last page only.
//   - page numbers are stamped AFTER the merge by the shared stamp step
//     (src/render/stamp.js) — the same function SinglePass uses — so footers
//     are continuous and identical across strategies.

const { PDFDocument } = require('pdf-lib');
const config = require('../config');
const { buildPurchaseOrderHtml } = require('./template');
const { stampPageNumbers } = require('./stamp');

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

const PDF_OPTS = {
  format: 'A4',
  printBackground: true,
  margin: { top: '0', bottom: '0', left: '0', right: '0' },
};

// Merge chunk PDFs into one document (no numbering here — see stamp step).
async function merge(pdfBuffers) {
  const out = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

// Render one document via chunking. `page` is the pooled task page; `chunkSize`
// controls rows per chunk (snapped up to a whole number of sheets).
async function render(page, doc, { chunkSize, rowsPerPage } = {}) {
  const rpp = rowsPerPage || config.render.rowsPerPage;
  const requested = chunkSize || config.render.chunkSize;
  // Snap chunk size up to a multiple of rowsPerPage so chunk boundaries align
  // with sheet boundaries (the equivalence invariant).
  const size = Math.max(rpp, Math.ceil(requested / rpp) * rpp);

  const currency = doc.currency || 'USD';
  const grandTotal = doc.lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);
  const chunks = chunk(doc.lineItems, size);

  const buffers = [];
  for (let c = 0; c < chunks.length; c++) {
    const isLast = c === chunks.length - 1;
    const html = buildPurchaseOrderHtml(doc, {
      items: chunks[c],
      startIndex: c * size,
      showTotal: isLast,
      grandTotal,
      rowsPerPage: rpp,
    });
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf(PDF_OPTS);
    buffers.push(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf));
  }

  return stampPageNumbers(await merge(buffers));
}

module.exports = { render, merge, name: 'ChunkedMerge' };
