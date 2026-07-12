'use strict';

// Enqueue-time validation. Everything a document needs to render is checked
// HERE, synchronously, before the job is snapshotted or enqueued. Malformed
// documents are rejected in the API response and never reach a render worker.

const MAX_BULK_DOCUMENTS = 100;
const SUPPORTED_TYPES = ['purchase_order'];

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
  }
  if (!isNonEmptyString(doc.poNumber)) {
    errors.push('poNumber is required and must be a non-empty string');
  }

  if (!isObject(doc.vendor)) {
    errors.push('vendor is required and must be an object');
  } else if (!isNonEmptyString(doc.vendor.name)) {
    errors.push('vendor.name is required and must be a non-empty string');
  }

  if (doc.buyer !== undefined && !isObject(doc.buyer)) {
    errors.push('buyer, if present, must be an object');
  }

  if (doc.currency !== undefined && !isNonEmptyString(doc.currency)) {
    errors.push('currency, if present, must be a non-empty string');
  }

  if (!Array.isArray(doc.lineItems) || doc.lineItems.length === 0) {
    errors.push('lineItems is required and must be a non-empty array');
  } else {
    doc.lineItems.forEach((li, i) => {
      if (!isObject(li)) {
        errors.push(`lineItems[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(li.description)) {
        errors.push(`lineItems[${i}].description is required and must be a non-empty string`);
      }
      if (!isFiniteNumber(li.quantity) || li.quantity <= 0) {
        errors.push(`lineItems[${i}].quantity must be a number > 0`);
      }
      if (!isFiniteNumber(li.unitPrice) || li.unitPrice < 0) {
        errors.push(`lineItems[${i}].unitPrice must be a number >= 0`);
      }
    });
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
    docs.forEach((doc, index) => {
      const errs = validateDocument(doc);
      if (errs.length > 0) {
        documentErrors.push({
          index,
          documentId: isObject(doc) && isNonEmptyString(doc.documentId) ? doc.documentId : null,
          errors: errs,
        });
      }
    });
  }

  const valid = topErrors.length === 0 && documentErrors.length === 0;
  // Priority is inferred: 1 document => single (fast lane), >1 => bulk.
  const priority = docs.length === 1 ? 'single' : 'bulk';

  return { valid, priority, documentCount: docs.length, topErrors, documentErrors };
}

module.exports = { MAX_BULK_DOCUMENTS, SUPPORTED_TYPES, validateDocument, validateJobRequest };
