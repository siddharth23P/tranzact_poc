'use strict';

// Purchase-order HTML template. EVERY interpolated value is passed through
// escapeHtml — there is no raw user data in the output. Totals are computed
// server-side from the (already validated) numeric fields.
//
// PAGINATION IS EXPLICIT AND DETERMINISTIC. The template splits line items into
// fixed-size "sheets" of `rowsPerPage` rows; each sheet is a fixed-height
// (one-A4-page) block with `page-break-after`, its own table header, and a
// clipped overflow — so one sheet always equals exactly one PDF page. Row
// heights are fixed (no wrapping; long text is ellipsized) so the layout cannot
// drift with content.
//
// This is what makes SinglePass and ChunkedMerge page-equivalent by
// construction: as long as ChunkedMerge's chunk size is a multiple of
// rowsPerPage, both strategies emit the exact same sequence of sheets — the
// only difference is whether they were printed in one Chromium pass or several
// and stitched. It also gives every page a table header for free.

const { escapeHtml } = require('./escape');

const e = escapeHtml;
// 10 rows/sheet: each row is a fixed 4-wrapped-line box (see CSS notes below),
// sized so the first sheet (full header) + rows + total row always fit one A4.
const DEFAULT_ROWS_PER_PAGE = 10;

function money(amount, currency) {
  const n = Number.isFinite(amount) ? amount : 0;
  // Currency is escaped; amount is a validated number, formatted fixed.
  return `${e(currency || 'USD')} ${n.toFixed(2)}`;
}

function chunkRows(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function lineItemRows(lineItems, currency, startIndex) {
  return lineItems
    .map((li, i) => {
      const lineTotal = li.quantity * li.unitPrice;
      // Description wraps inside a fixed 4-line box (.cell). NOTHING is
      // ellipsized: validation caps description length so the max validated
      // value always fits the box (see LIMITS in src/validation.js); the
      // overflow:hidden is a backstop that validated data can never hit.
      return `
        <tr>
          <td class="idx">${startIndex + i + 1}</td>
          <td class="desc"><div class="cell">${e(li.description)}</div></td>
          <td class="num">${e(li.quantity)}</td>
          <td class="num">${money(li.unitPrice, currency)}</td>
          <td class="num">${money(lineTotal, currency)}</td>
        </tr>`;
    })
    .join('');
}

function addressBlock(label, party) {
  if (!party) return '';
  const name = e(party.name);
  const address = party.address ? `<div class="addr">${e(party.address)}</div>` : '';
  return `
    <div class="party">
      <div class="party-label">${e(label)}</div>
      <div class="party-name">${name}</div>
      ${address}
    </div>`;
}

// Full header — only on the very first sheet of the document.
function fullHeader(doc) {
  return `
  <h1>Purchase Order</h1>
  <div class="doc-meta">
    PO Number: <strong>${e(doc.poNumber)}</strong>
    &nbsp;·&nbsp; Document ID: ${e(doc.documentId)}
  </div>
  <div class="parties">
    ${addressBlock('Vendor', doc.vendor)}
    ${addressBlock('Buyer', doc.buyer)}
  </div>`;
}

// Compact header for continuation sheets.
function continuedHeader(doc) {
  return `
  <div class="cont">Purchase Order <strong>${e(doc.poNumber)}</strong> — continued</div>`;
}

function tableHtml(rows, currency, startIndex, totalRow) {
  return `
  <table>
    <thead>
      <tr>
        <th class="idx">#</th>
        <th>Description</th>
        <th class="num qty">Qty</th>
        <th class="num unit">Unit Price</th>
        <th class="num amount">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemRows(rows, currency, startIndex)}
    </tbody>
    ${
      totalRow
        ? `<tfoot>
      <tr>
        <td colspan="4" class="total-label">Total</td>
        <td class="num">${money(totalRow.grandTotal, currency)}</td>
      </tr>
    </tfoot>`
        : ''
    }
  </table>`;
}

// Layout invariants (paired with LIMITS in src/validation.js — change together):
//   - every data row is a fixed 64px box: description wraps up to 4 lines of
//     14px line-height inside .cell (max validated length 110 chars always fits
//     at worst-case glyph widths in the ~357px description column);
//   - header boxes are fixed-height (.doc-meta 2 lines, .party-name 2 lines,
//     .addr 3 lines) and validation caps those fields to fit;
//   - numeric columns are sized for the validated numeric maxima with a 3-char
//     ISO-4217 currency code;
//   - NOTHING is ellipsized. overflow:hidden appears only as a backstop that
//     validated data cannot reach (it keeps pagination deterministic if an
//     unvalidated path ever feeds the template).
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 12px; }
  .sheet { width: 210mm; height: 296mm; padding: 12mm 12mm 16mm; overflow: hidden;
           page-break-after: always; }
  .sheet.last { page-break-after: auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .doc-meta { color: #555; margin-bottom: 12px; height: 36px; overflow: hidden; }
  .cont { color: #555; font-size: 12px; height: 24px; overflow: hidden; }
  .parties { display: flex; gap: 48px; margin-bottom: 12px; height: 104px; overflow: hidden; }
  .party { width: 46%; }
  .party-label { text-transform: uppercase; font-size: 10px; color: #888; letter-spacing: .05em; }
  .party-name { font-weight: bold; font-size: 13px; line-height: 17px; height: 34px; overflow: hidden; }
  .addr { color: #444; white-space: pre-line; line-height: 15px; height: 45px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: 4px 10px; border-bottom: 1px solid #e0e0e0; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
       color: #555; height: 26px; white-space: nowrap; }
  td { height: 64px; }
  td .cell { line-height: 14px; max-height: 56px; overflow: hidden; overflow-wrap: anywhere; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  th.qty, td.qty-col { width: 60px; }
  th.unit { width: 110px; }
  th.amount { width: 120px; }
  td.idx, th.idx { color: #999; width: 36px; }
  tfoot td { font-weight: bold; border-top: 2px solid #333; border-bottom: none; height: 32px; }
  .total-label { text-align: right; }
`;

// Build a complete standalone HTML document for a purchase order (or one chunk
// of it), pre-paginated into fixed-height sheets. Options support ChunkedMerge:
//   opts.items       - the line-item slice to render (default: all)
//   opts.startIndex  - absolute index of the first row in this slice (for
//                      continuous line numbering across chunks; default 0)
//   opts.showTotal   - render the grand-total footer on the last sheet
//                      (default true; ChunkedMerge sets it only on the LAST chunk)
//   opts.grandTotal  - the total to show (default: sum over `items`; ChunkedMerge
//                      passes the total over ALL items)
//   opts.rowsPerPage - rows per sheet (callers pass config.render.rowsPerPage)
function buildPurchaseOrderHtml(doc, opts = {}) {
  const currency = doc.currency || 'USD';
  const items = opts.items || doc.lineItems;
  const startIndex = opts.startIndex || 0;
  const showTotal = opts.showTotal !== false;
  const rowsPerPage = opts.rowsPerPage || DEFAULT_ROWS_PER_PAGE;
  const grandTotal =
    opts.grandTotal != null
      ? opts.grandTotal
      : items.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);

  const pages = chunkRows(items, rowsPerPage);
  const sheets = pages
    .map((rows, p) => {
      const absStart = startIndex + p * rowsPerPage;
      const isFirstOfDoc = absStart === 0;
      const isLastOfRender = p === pages.length - 1;
      const header = isFirstOfDoc ? fullHeader(doc) : continuedHeader(doc);
      const totalRow = isLastOfRender && showTotal ? { grandTotal } : null;
      const lastClass = isLastOfRender ? ' last' : '';
      return `<div class="sheet${lastClass}">${header}${tableHtml(rows, currency, absStart, totalRow)}</div>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Purchase Order ${e(doc.poNumber)}</title>
<style>${CSS}</style>
</head>
<body>
${sheets}
</body>
</html>`;
}

module.exports = { buildPurchaseOrderHtml, DEFAULT_ROWS_PER_PAGE };
