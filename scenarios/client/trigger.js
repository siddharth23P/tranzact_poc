'use strict';

// Trigger client — submits render jobs to pdf-service EXACTLY as the ERP
// backend (Django) would: read entities from the ERP, map them to the POST
// /jobs document shape, send one JSON request with an idempotency key.
//
//   node scenarios/client/trigger.js single [entityId]
//   node scenarios/client/trigger.js bulk <count> [idempotencyKey]
//
// env: MOCK_ERP_URL (default http://localhost:4000)
//      PDF_API      (default http://localhost:3000)

const MOCK_ERP_URL = process.env.MOCK_ERP_URL || 'http://localhost:4000';
const PDF_API = process.env.PDF_API || 'http://localhost:3000';

// Same mapping the ERP would apply: entity -> render document.
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

async function fetchEntities(count) {
  const res = await fetch(`${MOCK_ERP_URL}/purchase-orders?limit=${count}`);
  if (!res.ok) throw new Error(`mock-erp list failed: ${res.status}`);
  return (await res.json()).items;
}

async function fetchEntity(id) {
  const res = await fetch(`${MOCK_ERP_URL}/purchase-orders/${id}`);
  if (!res.ok) throw new Error(`mock-erp get ${id} failed: ${res.status}`);
  return res.json();
}

async function submitJob(documents, idempotencyKey) {
  const res = await fetch(`${PDF_API}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(idempotencyKey ? { idempotencyKey } : {}), documents }),
  });
  const json = await res.json();
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`POST /jobs failed ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

async function triggerSingle(entityId) {
  const entity = entityId ? await fetchEntity(entityId) : (await fetchEntities(1))[0];
  return submitJob([entityToDocument(entity)]);
}

async function triggerBulk(count, idempotencyKey) {
  const entities = await fetchEntities(count);
  if (entities.length < count) throw new Error(`only ${entities.length} entities available, wanted ${count}`);
  return { job: await submitJob(entities.map(entityToDocument), idempotencyKey), entities };
}

module.exports = { entityToDocument, fetchEntities, fetchEntity, submitJob, triggerSingle, triggerBulk };

if (require.main === module) {
  (async () => {
    const [mode, arg, key] = process.argv.slice(2);
    if (mode === 'single') {
      const job = await triggerSingle(arg);
      console.log(JSON.stringify(job, null, 2));
    } else if (mode === 'bulk') {
      const { job } = await triggerBulk(parseInt(arg || '10', 10), key);
      console.log(JSON.stringify(job, null, 2));
    } else {
      console.error('usage: trigger.js single [entityId] | bulk <count> [idempotencyKey]');
      process.exit(2);
    }
  })().catch((e) => { console.error('trigger failed:', e.message); process.exit(1); });
}
