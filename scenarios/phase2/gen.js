'use strict';

// Deterministic payload generator for the POST /jobs verification suite.
// These double as the seed of the phase-6 fixture matrix (valid single/bulk
// purchase orders + the rejection edge cases). No randomness — same output
// every run — so diffs are meaningful and curl fixtures are stable.
//
//   node scenarios/phase2/gen.js        # (re)writes scenarios/phase2/payloads/*.json

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'payloads');

// A valid purchase-order document with a parameterized line-item count.
function purchaseOrder(i, lineItemCount = 2) {
  const lineItems = [];
  for (let n = 0; n < lineItemCount; n++) {
    lineItems.push({
      description: `Item ${n + 1} for PO ${1000 + i}`,
      quantity: (n % 5) + 1,
      unitPrice: Number(((n + 1) * 3.5).toFixed(2)),
    });
  }
  return {
    documentId: `DOC-${i}`,
    type: 'purchase_order',
    poNumber: `PO-${1000 + i}`,
    vendor: { name: `Vendor ${i}`, address: `${i} Market St, Springfield` },
    buyer: { name: 'TranZact ERP', address: '500 Enterprise Way' },
    currency: 'USD',
    lineItems,
  };
}

function bulk(n, extra = {}, lineItemCount = 2) {
  return { ...extra, documents: Array.from({ length: n }, (_, i) => purchaseOrder(i, lineItemCount)) };
}

// A document whose USER DATA contains template-ish payloads. These must render
// as literal text — the template uses JS template literals over ALREADY-escaped
// values, and there is no `{{ }}` engine and no eval of user strings, so neither
// `{{payload}}` nor `${payload}` is interpolated.
function injectionDoc() {
  return {
    documentId: 'INJECT-1',
    type: 'purchase_order',
    poNumber: 'PO-{{payload}}',
    vendor: { name: 'Vendor ${payload}', address: 'addr {{payload}} ${payload}' },
    buyer: { name: 'Buyer {{payload}}' },
    currency: 'USD',
    lineItems: [
      { description: 'Line {{payload}} and ${payload}', quantity: 1, unitPrice: 9.99 },
      { description: '${constructor.constructor("return 1")()}', quantity: 2, unitPrice: 5 },
    ],
  };
}

const payloads = {
  // Valid cases
  single: bulk(1),
  bulk: bulk(3),
  idempotent: bulk(1, { idempotencyKey: 'order-batch-42' }),
  // Large document -> exceeds CHUNK_THRESHOLD, exercises ChunkedMerge.
  large_lineitems: { documents: [purchaseOrder(0, 120)] },
  // Template-injection fixture (renders literally).
  injection: { documents: [injectionDoc()] },
  // Rejection cases
  empty: { documents: [] },
  oversize_101: bulk(101),
  malformed: {
    documents: [
      { documentId: 'BAD-0', poNumber: 'PO-x', vendor: {}, lineItems: [] },
      {
        documentId: 'BAD-1',
        poNumber: 'PO-y',
        vendor: { name: 'V' },
        lineItems: [{ description: 'x', quantity: 0, unitPrice: -5 }],
      },
    ],
  },
};

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, body] of Object.entries(payloads)) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
    console.log(`wrote payloads/${name}.json`);
  }
}

module.exports = { purchaseOrder, bulk, injectionDoc, payloads };
