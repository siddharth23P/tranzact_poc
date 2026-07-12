'use strict';

// Shared page-number stamping. BOTH strategies produce their raw PDF bytes and
// then pass them through this ONE function, so the "Page X of Y" footer is
// identical by construction:
//   - SinglePass:  render -> stampPageNumbers(bytes)
//   - ChunkedMerge: render chunks -> merge -> stampPageNumbers(merged bytes)
// Numbering is applied over the FINAL document in both cases, so it is always
// continuous regardless of how the pages were produced.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function stampPageNumbers(pdfBuffer) {
  const doc = await PDFDocument.load(pdfBuffer);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = doc.getPageCount();

  doc.getPages().forEach((page, i) => {
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

  return Buffer.from(await doc.save());
}

module.exports = { stampPageNumbers };
