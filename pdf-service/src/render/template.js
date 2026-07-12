'use strict';

// Purchase-order HTML template. EVERY interpolated value is passed through
// escapeHtml — there is no raw user data in the output. Totals are computed
// server-side from the (already validated) numeric fields.

const { escapeHtml } = require('./escape');

const e = escapeHtml;

function money(amount, currency) {
  const n = Number.isFinite(amount) ? amount : 0;
  // Currency is escaped; amount is a validated number, formatted fixed.
  return `${e(currency || 'USD')} ${n.toFixed(2)}`;
}

function lineItemRows(lineItems, currency) {
  return lineItems
    .map((li, i) => {
      const lineTotal = li.quantity * li.unitPrice;
      return `
        <tr>
          <td class="idx">${i + 1}</td>
          <td>${e(li.description)}</td>
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

// Build a complete standalone HTML document for one purchase order.
function buildPurchaseOrderHtml(doc) {
  const currency = doc.currency || 'USD';
  const grandTotal = doc.lineItems.reduce((sum, li) => sum + li.quantity * li.unitPrice, 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Purchase Order ${e(doc.poNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 40px; font-size: 12px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .doc-meta { color: #555; margin-bottom: 24px; }
  .parties { display: flex; gap: 48px; margin-bottom: 24px; }
  .party-label { text-transform: uppercase; font-size: 10px; color: #888; letter-spacing: .05em; }
  .party-name { font-weight: bold; font-size: 13px; }
  .addr { color: #444; white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e0e0e0; text-align: left; }
  th { background: #f5f5f5; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #555; }
  td.num, th.num { text-align: right; }
  td.idx { color: #999; width: 32px; }
  tfoot td { font-weight: bold; border-top: 2px solid #333; border-bottom: none; }
  .total-label { text-align: right; }
</style>
</head>
<body>
  <h1>Purchase Order</h1>
  <div class="doc-meta">
    PO Number: <strong>${e(doc.poNumber)}</strong>
    &nbsp;·&nbsp; Document ID: ${e(doc.documentId)}
  </div>

  <div class="parties">
    ${addressBlock('Vendor', doc.vendor)}
    ${addressBlock('Buyer', doc.buyer)}
  </div>

  <table>
    <thead>
      <tr>
        <th class="idx">#</th>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemRows(doc.lineItems, currency)}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="total-label">Total</td>
        <td class="num">${money(grandTotal, currency)}</td>
      </tr>
    </tfoot>
  </table>
</body>
</html>`;
}

module.exports = { buildPurchaseOrderHtml };
