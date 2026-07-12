'use strict';

// Enqueue-time validation. Everything a document needs to render is checked
// HERE, synchronously, before the job is snapshotted or enqueued. Malformed
// documents are rejected in the API response and never reach a render worker.

const MAX_BULK_DOCUMENTS = 100;
const SUPPORTED_TYPES = ['purchase_order'];

// Layout-derived field limits. The sealed PDF must contain EXACTLY the
// validated source data — nothing is ever ellipsized or clipped at render time.
// That only works if enqueue-time validation bounds every field to what its
// fixed layout slot can hold at worst-case glyph widths:
//   - description: 4 wrapped lines × ≥27 worst-case chars/line in its column
//   - party name: 2 lines; address: 3 lines (incl. user newlines)
//   - money columns sized for the numeric maxima below (ISO-4217 currency)
// If a limit changes, re-derive the template row/box heights (src/render/
// template.js) and re-run prove:no-truncation + prove:equivalence.
const LIMITS = {
  description: 110,
  documentId: 48,
  poNumber: 32,
  partyName: 50,
  partyAddress: 75,
  partyAddressLines: 3,
  quantityMax: 1e6,
  unitPriceMax: 1e6,
  lineAmountMax: 1e7,
  documentTotalMax: 1e8,
};
const CURRENCY_RE = /^[A-Z]{3}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// Validate one purchase-order document. Returns an array of error strings
// (empty === valid). Collects ALL problems, not just the first.
function validateDocument(doc) {
  const errors = [];

  if (!isObject(doc)) {
    return ['document must be a JSON object'];
  }

  const type = doc.type === undefined ? 'purchase_order' : doc.type;
  if (!SUPPORTED_TYPES.includes(type)) {
    errors.push(`type must be one of [${SUPPORTED_TYPES.join(', ')}] (got ${JSON.stringify(doc.type)})`);
  }

  if (!isNonEmptyString(doc.documentId)) {
    errors.push('documentId is required and must be a non-empty string');
  } else if (doc.documentId.length > LIMITS.documentId) {
    errors.push(`documentId exceeds max length ${LIMITS.documentId} (got ${doc.documentId.length})`);
  }
  if (!isNonEmptyString(doc.poNumber)) {
    errors.push('poNumber is required and must be a non-empty string');
  } else if (doc.poNumber.length > LIMITS.poNumber) {
    errors.push(`poNumber exceeds max length ${LIMITS.poNumber} (got ${doc.poNumber.length})`);
  }

  const checkParty = (party, field, required) => {
    if (party === undefined) {
      if (required) errors.push(`${field} is required and must be an object`);
      return;
    }
    if (!isObject(party)) {
      errors.push(`${field} must be an object`);
      return;
    }
    if (!isNonEmptyString(party.name)) {
      errors.push(`${field}.name is required and must be a non-empty string`);
    } else if (party.name.length > LIMITS.partyName) {
      errors.push(`${field}.name exceeds max length ${LIMITS.partyName} (got ${party.name.length})`);
    }
    if (party.address !== undefined) {
      if (!isNonEmptyString(party.address)) {
        errors.push(`${field}.address, if present, must be a non-empty string`);
      } else {
        if (party.address.length > LIMITS.partyAddress) {
          errors.push(`${field}.address exceeds max length ${LIMITS.partyAddress} (got ${party.address.length})`);
        }
        const lines = party.address.split('\n').length;
        if (lines > LIMITS.partyAddressLines) {
          errors.push(`${field}.address exceeds max ${LIMITS.partyAddressLines} lines (got ${lines})`);
        }
      }
    }
  };
  checkParty(doc.vendor, 'vendor', true);
  checkParty(doc.buyer, 'buyer', false);

  if (doc.currency !== undefined && !CURRENCY_RE.test(doc.currency)) {
    errors.push('currency, if present, must be a 3-letter uppercase ISO-4217 code');
  }

  if (!Array.isArray(doc.lineItems) || doc.lineItems.length === 0) {
    errors.push('lineItems is required and must be a non-empty array');
  } else {
    let documentTotal = 0;
    doc.lineItems.forEach((li, i) => {
      if (!isObject(li)) {
        errors.push(`lineItems[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(li.description)) {
        errors.push(`lineItems[${i}].description is required and must be a non-empty string`);
      } else if (li.description.length > LIMITS.description) {
        errors.push(
          `lineItems[${i}].description exceeds max length ${LIMITS.description} (got ${li.description.length})`
        );
      }
      const qtyOk = isFiniteNumber(li.quantity) && li.quantity > 0 && li.quantity <= LIMITS.quantityMax;
      if (!qtyOk) {
        errors.push(`lineItems[${i}].quantity must be a number in (0, ${LIMITS.quantityMax}]`);
      }
      const priceOk =
        isFiniteNumber(li.unitPrice) && li.unitPrice >= 0 && li.unitPrice <= LIMITS.unitPriceMax;
      if (!priceOk) {
        errors.push(`lineItems[${i}].unitPrice must be a number in [0, ${LIMITS.unitPriceMax}]`);
      }
      if (qtyOk && priceOk) {
        const amount = li.quantity * li.unitPrice;
        if (amount > LIMITS.lineAmountMax) {
          errors.push(`lineItems[${i}] amount (qty*unitPrice) exceeds max ${LIMITS.lineAmountMax}`);
        }
        documentTotal += amount;
      }
    });
    if (documentTotal > LIMITS.documentTotalMax) {
      errors.push(`document total exceeds max ${LIMITS.documentTotalMax}`);
    }
  }

  return errors;
}

// Validate the whole POST /jobs request body. Returns:
//   { valid, priority, documentCount, topErrors[], documentErrors[] }
// - topErrors: request-level problems (missing array, empty, > max).
// - documentErrors: [{ index, documentId, errors[] }] per malformed document.
function validateJobRequest(body) {
  const topErrors = [];

  if (!isObject(body)) {
    return { valid: false, topErrors: ['request body must be a JSON object'], documentErrors: [] };
  }

  if (body.idempotencyKey !== undefined && !isNonEmptyString(body.idempotencyKey)) {
    topErrors.push('idempotencyKey, if present, must be a non-empty string');
  }

  const docs = body.documents;
  if (!Array.isArray(docs)) {
    topErrors.push('documents is required and must be an array');
    return { valid: false, topErrors, documentErrors: [] };
  }
  if (docs.length === 0) {
    topErrors.push('documents must be a non-empty array (got 0)');
  }
  if (docs.length > MAX_BULK_DOCUMENTS) {
    topErrors.push(`documents exceeds max of ${MAX_BULK_DOCUMENTS} per job (got ${docs.length})`);
  }

  const documentErrors = [];
  // Only bother per-document validation when the array size itself is sane.
  if (docs.length > 0 && docs.length <= MAX_BULK_DOCUMENTS) {
    const seenIds = new Map(); // documentId -> first index
    docs.forEach((doc, index) => {
      const errs = validateDocument(doc);
      // Duplicate documentIds within one job are a data error (two "documents"
      // claiming the same identity) — reject at enqueue like everything else.
      const docId = isObject(doc) && isNonEmptyString(doc.documentId) ? doc.documentId : null;
      if (docId) {
        if (seenIds.has(docId)) {
          errs.push(`documentId "${docId}" duplicates documents[${seenIds.get(docId)}]`);
        } else {
          seenIds.set(docId, index);
        }
      }
      if (errs.length > 0) {
        documentErrors.push({ index, documentId: docId, errors: errs });
      }
    });
  }

  const valid = topErrors.length === 0 && documentErrors.length === 0;
  // Priority is inferred: 1 document => single (fast lane), >1 => bulk.
  const priority = docs.length === 1 ? 'single' : 'bulk';

  return { valid, priority, documentCount: docs.length, topErrors, documentErrors };
}

module.exports = { MAX_BULK_DOCUMENTS, SUPPORTED_TYPES, LIMITS, validateDocument, validateJobRequest };
