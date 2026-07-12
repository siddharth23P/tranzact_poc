'use strict';

// ChunkedMerge render strategy: for documents with many line items, render the
// items in row-chunks of CHUNK_SIZE (each via the SAME escaped template) and
// stitch the chunk PDFs into one with pdf-lib. Chunks are rendered sequentially
// on the single task-held page (page-per-task still holds).
//
// Correctness across chunks:
//   - line numbering is continuous (startIndex offset per chunk);
//   - the grand total is computed over ALL items and shown only on the last
//     chunk;
//   - PAGE NUMBERS are applied AFTER the merge over the whole document, so
//     "Page X of Y" is continuous regardless of how chunks fell across pages.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { buildPurchaseOrderHtml } = require('./template');

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

// Merge chunk PDFs and stamp continuous page numbers across the final document.
async function mergeAndNumber(pdfBuffers) {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);

  for (const buf of pdfBuffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }

  const total = out.getPageCount();
  out.getPages().forEach((page, i) => {
    const { width } = page.getSize();
    const text = `Page ${i + 1} of ${total}`;
    const size = 9;
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: width - textWidth - 24,
      y: 18,
      size,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  });

  return Buffer.from(await out.save());
}

// Render one document via chunking. `page` is the pooled task page; `chunkSize`
// controls rows per chunk.
async function render(page, doc, { chunkSize } = {}) {
  const size = chunkSize || 40;
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
    });
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf(PDF_OPTS);
    buffers.push(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf));
  }

  return mergeAndNumber(buffers);
}

module.exports = { render, mergeAndNumber, name: 'ChunkedMerge' };
