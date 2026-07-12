'use strict';

// Seeded fixture generator (deterministic: same seed -> same bytes).
//
// Two outputs:
//   1. makeEntities(seed, count) — purchase-order/invoice entities used to seed
//      the mock-erp in-memory store (parameterized line-item count).
//   2. `node fixtures/generator.js` — emits the full test matrix as named
//      payload files under fixtures/data/ (each file is a POST /jobs body,
//      except parser_truncated.json which is deliberately broken JSON).
//
// All generated values respect the pdf-service validation LIMITS (description
// <=110, names <=50, addresses <=75 & <=3 lines, ISO-4217 currency, numeric
// caps) — fixtures that are MEANT to violate limits are constructed explicitly
// in the matrix section.

const fs = require('fs');
const path = require('path');
const { faker } = require('@faker-js/faker');

const OUT = path.join(__dirname, 'data');

function clamp(s, max) {
  return String(s).slice(0, max);
}

// ---------------------------------------------------------------------------
// Entities (store seed)
// ---------------------------------------------------------------------------

function makeLineItems(count) {
  const items = [];
  for (let n = 0; n < count; n++) {
    items.push({
      description: clamp(`${faker.commerce.productName()} — ${faker.commerce.productMaterial()}`, 110),
      quantity: faker.number.int({ min: 1, max: 50 }),
      unitPrice: Number(faker.commerce.price({ min: 1, max: 5000, dec: 2 })),
    });
  }
  return items;
}

function makeParty() {
  return {
    name: clamp(faker.company.name(), 50),
    address: clamp(`${faker.location.streetAddress()}\n${faker.location.city()}, ${faker.location.state({ abbreviated: true })}`, 75),
  };
}

// Deterministic entity set. lineItemCount can be a number or a function(i).
function makeEntities(seed = 42, count = 120, lineItemCount = (i) => 3 + (i % 8)) {
  faker.seed(seed);
  const purchaseOrders = [];
  for (let i = 0; i < count; i++) {
    const n = typeof lineItemCount === 'function' ? lineItemCount(i) : lineItemCount;
    purchaseOrders.push({
      id: `PO-${String(i).padStart(4, '0')}`,
      poNumber: `PO/${2026}/${String(i).padStart(5, '0')}`,
      vendor: makeParty(),
      buyer: makeParty(),
      currency: 'USD',
      lineItems: makeLineItems(n),
      updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
  }
  const invoices = [];
  for (let i = 0; i < Math.floor(count / 4); i++) {
    invoices.push({
      id: `INV-${String(i).padStart(4, '0')}`,
      invoiceNumber: `INV/${2026}/${String(i).padStart(5, '0')}`,
      purchaseOrderId: `PO-${String(i).padStart(4, '0')}`,
      vendor: makeParty(),
      buyer: makeParty(),
      currency: 'USD',
      lineItems: makeLineItems(3),
      updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    });
  }
  return { purchaseOrders, invoices };
}

// Entity -> POST /jobs document (what the trigger client sends — "as Django would").
function entityToDocument(po) {
  return {
    documentId: po.id,
    type: 'purchase_order',
    poNumber: po.poNumber,
    vendor: po.vendor,
    buyer: po.buyer,
    currency: po.currency,
    lineItems: po.lineItems,
  };
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

function rowsDoc(id, rows) {
  faker.seed(1000 + rows);
  // Bounded numerics: at up to 2000 rows the DOCUMENT total must stay under
  // the validated cap (1e8). qty<=10 × price<=100 -> worst total 2000*1000=2e6.
  const lineItems = [];
  for (let n = 0; n < rows; n++) {
    lineItems.push({
      description: clamp(`${faker.commerce.productName()} — ${faker.commerce.productMaterial()}`, 110),
      quantity: faker.number.int({ min: 1, max: 10 }),
      unitPrice: Number(faker.commerce.price({ min: 1, max: 100, dec: 2 })),
    });
  }
  return {
    documentId: id,
    type: 'purchase_order',
    poNumber: `PO-ROWS-${rows}`,
    vendor: makeParty(),
    buyer: makeParty(),
    currency: 'USD',
    lineItems,
  };
}

function buildMatrix() {
  faker.seed(42);

  const nearLimitDesc = 'NEARLIMIT-' + 'abcdefghij'.repeat(10); // exactly 110

  const matrix = {
    // ---- renderer ----
    renderer_rows_0: { expect: 400, body: { documents: [rowsDoc('ROWS-0', 0)] } },
    renderer_rows_500: { expect: 201, render: true, body: { documents: [rowsDoc('ROWS-500', 500)] } },
    renderer_rows_1000: { expect: 201, render: true, body: { documents: [rowsDoc('ROWS-1000', 1000)] } },
    renderer_rows_2000: { expect: 201, render: true, body: { documents: [rowsDoc('ROWS-2000', 2000)] } },
    renderer_near_limit_description: {
      expect: 201,
      render: true,
      body: {
        documents: [
          {
            documentId: 'NEARLIMIT-1',
            type: 'purchase_order',
            poNumber: 'PO-NL-1',
            vendor: { name: 'Near Limit Vendor' },
            currency: 'USD',
            lineItems: [{ description: nearLimitDesc, quantity: 2, unitPrice: 9.99 }],
          },
        ],
      },
    },

    // ---- parser (all rejected at the API boundary) ----
    parser_missing_fields: {
      expect: 400,
      body: { documents: [{ documentId: 'MISS-1' /* no poNumber/vendor/lineItems */ }] },
    },
    parser_quantity_string: {
      expect: 400,
      body: {
        documents: [
          {
            documentId: 'QSTR-1', poNumber: 'PO-1', vendor: { name: 'V' }, currency: 'USD',
            lineItems: [{ description: 'ten of these', quantity: 'ten', unitPrice: 5 }],
          },
        ],
      },
    },
    parser_negative_values: {
      expect: 400,
      body: {
        documents: [
          {
            documentId: 'NEG-1', poNumber: 'PO-1', vendor: { name: 'V' }, currency: 'USD',
            lineItems: [{ description: 'negative', quantity: -3, unitPrice: -9.99 }],
          },
        ],
      },
    },
    parser_null_fields: {
      expect: 400,
      body: {
        documents: [
          {
            documentId: null, poNumber: null, vendor: null, currency: null,
            lineItems: [{ description: null, quantity: null, unitPrice: null }],
          },
        ],
      },
    },
    parser_duplicate_doc_ids: {
      expect: 400,
      body: {
        documents: [
          { documentId: 'DUP-1', poNumber: 'PO-1', vendor: { name: 'V' }, currency: 'USD',
            lineItems: [{ description: 'a', quantity: 1, unitPrice: 1 }] },
          { documentId: 'DUP-1', poNumber: 'PO-2', vendor: { name: 'W' }, currency: 'USD',
            lineItems: [{ description: 'b', quantity: 1, unitPrice: 1 }] },
        ],
      },
    },
    // parser_truncated is emitted as a literally broken file below.

    // ---- limits ----
    limits_bulk_100: {
      expect: 201,
      render: true,
      body: {
        documents: Array.from({ length: 100 }, (_, i) => ({
          documentId: `BULK100-${String(i).padStart(3, '0')}`,
          type: 'purchase_order',
          poNumber: `PO-B100-${i}`,
          vendor: { name: `Vendor ${i}` },
          currency: 'USD',
          lineItems: [
            { description: `Bulk item A for doc ${i}`, quantity: 1 + (i % 5), unitPrice: 9.99 },
            { description: `Bulk item B for doc ${i}`, quantity: 2, unitPrice: 4.5 },
            { description: `Bulk item C for doc ${i}`, quantity: 1, unitPrice: 100 },
          ],
        })),
      },
    },
    limits_bulk_101: {
      expect: 400,
      body: {
        documents: Array.from({ length: 101 }, (_, i) => ({
          documentId: `BULK101-${String(i).padStart(3, '0')}`,
          type: 'purchase_order',
          poNumber: `PO-B101-${i}`,
          vendor: { name: `Vendor ${i}` },
          currency: 'USD',
          lineItems: [{ description: 'x', quantity: 1, unitPrice: 1 }],
        })),
      },
    },
    limits_empty: { expect: 400, body: { documents: [] } },

    // ---- locale ----
    locale_indic: {
      expect: 201,
      render: true,
      body: {
        documents: [
          {
            documentId: 'INDIC-1',
            type: 'purchase_order',
            poNumber: 'PO/MH/2026/00087',
            vendor: { name: 'श्री बालाजी ट्रेडर्स प्रा. लि.', address: 'प्लॉट 12, एमआयडीसी\nपुणे, महाराष्ट्र' },
            buyer: { name: 'சென்னை சப்ளையர்ஸ்', address: '12, அண்ணா சாலை\nசென்னை' },
            currency: 'INR',
            lineItems: [
              { description: 'स्टील ब्रैकेट 40मिमी — जस्ता लेपित', quantity: 100, unitPrice: 45.5 },
              { description: 'நீளமான எஃகு தகடு 2மீ', quantity: 12, unitPrice: 799.0 },
            ],
          },
        ],
      },
    },
    locale_gst_intrastate: {
      expect: 201,
      render: true,
      body: {
        documents: [
          {
            documentId: 'GST-INTRA-1',
            type: 'purchase_order',
            poNumber: 'PO/MH/2026/00101',
            vendor: { name: 'Bharat Steels Pvt Ltd', address: 'MIDC Bhosari\nPune, Maharashtra' },
            buyer: { name: 'TranZact Manufacturing', address: 'Andheri East\nMumbai, Maharashtra' },
            currency: 'INR',
            lineItems: [
              { description: 'MS Angle 50x50x6 — taxable 999.99 + CGST 9% + SGST 9% (intra-state MH→MH)', quantity: 1, unitPrice: 1179.99 },
              { description: 'CGST 9% on 999.99 = 90.00 (rounded from 89.9991)', quantity: 1, unitPrice: 90.0 },
              { description: 'SGST 9% on 999.99 = 90.00 (rounded from 89.9991)', quantity: 1, unitPrice: 90.0 },
            ],
          },
        ],
      },
    },
    locale_gst_interstate: {
      expect: 201,
      render: true,
      body: {
        documents: [
          {
            documentId: 'GST-INTER-1',
            type: 'purchase_order',
            poNumber: 'PO/KA/2026/00102',
            vendor: { name: 'Bharat Steels Pvt Ltd', address: 'MIDC Bhosari\nPune, Maharashtra' },
            buyer: { name: 'Mysuru Fabricators', address: 'Hebbal Industrial Area\nMysuru, Karnataka' },
            currency: 'INR',
            lineItems: [
              { description: 'MS Angle 50x50x6 — taxable 999.99 + IGST 18% (inter-state MH→KA)', quantity: 1, unitPrice: 1179.99 },
              { description: 'IGST 18% on 999.99 = 180.00 (rounded from 179.9982)', quantity: 1, unitPrice: 180.0 },
            ],
          },
        ],
      },
    },
    locale_rounding_edges: {
      expect: 201,
      render: true,
      body: {
        documents: [
          {
            documentId: 'ROUND-1',
            type: 'purchase_order',
            poNumber: 'PO-ROUND-1',
            vendor: { name: 'Rounding Edge Cases Ltd' },
            currency: 'USD',
            lineItems: [
              { description: 'half-cent price: 0.005 (float is 0.00499…, renders 0.00)', quantity: 1, unitPrice: 0.005 },
              { description: 'near-ten: 9.995 (float is 9.99499…, renders 9.99)', quantity: 1, unitPrice: 9.995 },
              { description: 'repeating: 3 × 33.333 = 99.999 → 100.00', quantity: 3, unitPrice: 33.333 },
              { description: 'binary float artifact: 0.1 + 0.2 as a price', quantity: 1, unitPrice: 0.30000000000000004 },
            ],
          },
        ],
      },
    },
  };

  return matrix;
}

// ---------------------------------------------------------------------------
// CLI: emit the matrix as named files
// ---------------------------------------------------------------------------

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });

  const matrix = buildMatrix();
  const expectations = {};
  for (const [name, { expect, render, body }] of Object.entries(matrix)) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
    expectations[name] = { expect, render: !!render };
    console.log(`wrote data/${name}.json (expect ${expect})`);
  }

  // Deliberately broken JSON: a valid payload cut off mid-token.
  const whole = JSON.stringify({ documents: [rowsDoc('TRUNC-1', 3)] });
  fs.writeFileSync(path.join(OUT, 'parser_truncated.json'), whole.slice(0, Math.floor(whole.length / 2)));
  expectations.parser_truncated = { expect: 400, render: false, raw: true };
  console.log('wrote data/parser_truncated.json (deliberately invalid JSON, expect 400)');

  // Injection matrix entry: reuse the canonical fixture from scenarios/phase2.
  const inj = path.join(__dirname, '..', '..', 'scenarios', 'phase2', 'payloads', 'injection.json');
  fs.copyFileSync(inj, path.join(OUT, 'injection.json'));
  expectations.injection = { expect: 201, render: true };
  console.log('wrote data/injection.json (copied from scenarios/phase2, expect 201)');

  fs.writeFileSync(path.join(OUT, '_expectations.json'), JSON.stringify(expectations, null, 2) + '\n');
  console.log(`wrote data/_expectations.json (${Object.keys(expectations).length} cases)`);

  // Entity seed preview (the server regenerates the same set at boot).
  const entities = makeEntities();
  fs.writeFileSync(path.join(OUT, '_entities_preview.json'),
    JSON.stringify({ purchaseOrders: entities.purchaseOrders.slice(0, 3), counts: { purchaseOrders: entities.purchaseOrders.length, invoices: entities.invoices.length } }, null, 2) + '\n');
  console.log('wrote data/_entities_preview.json');
}

module.exports = { makeEntities, entityToDocument, buildMatrix };
