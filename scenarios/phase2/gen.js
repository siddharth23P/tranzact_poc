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

// Max validated description length (mirrors LIMITS.description in
// pdf-service/src/validation.js).
const MAX_DESC = 110;

// Deterministically pad a description to `len` chars (for wrapped-row tests).
function padDesc(base, len) {
  const filler = ' lorem-ipsum-filler-text';
  let s = base;
  while (s.length < len) s += filler;
  return s.slice(0, len);
}

// A valid purchase-order document with a parameterized line-item count.
// opts.descPad pads every description to that length (multi-line wrapped rows).
function purchaseOrder(i, lineItemCount = 2, opts = {}) {
  const lineItems = [];
  for (let n = 0; n < lineItemCount; n++) {
    const base = `Item ${n + 1} for PO ${1000 + i}`;
    lineItems.push({
      description: opts.descPad ? padDesc(base, opts.descPad) : base,
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
  // 10KB description -> MUST be rejected at enqueue (never silently clipped).
  oversize_description: {
    documents: [
      {
        documentId: 'OVERSIZE-1',
        type: 'purchase_order',
        poNumber: 'PO-OVR-1',
        vendor: { name: 'Oversize Vendor' },
        currency: 'USD',
        lineItems: [{ description: 'X'.repeat(10240), quantity: 1, unitPrice: 5 }],
      },
    ],
  },
  // Exactly-at-limit description -> MUST render fully (nothing clipped).
  near_limit_description: {
    documents: [
      {
        documentId: 'NEARLIMIT-1',
        type: 'purchase_order',
        poNumber: 'PO-NL-1',
        vendor: { name: 'Near Limit Vendor' },
        currency: 'USD',
        lineItems: [
          { description: 'NEARLIMIT-' + 'abcdefghij'.repeat(10), quantity: 2, unitPrice: 9.99 }, // 110 chars
        ],
      },
    ],
  },
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

module.exports = { purchaseOrder, bulk, injectionDoc, padDesc, MAX_DESC, payloads };
