'use strict';

// Mock ERP: entity CRUD over an in-memory store seeded from the deterministic
// fixture generator. Stands in for the Django ERP. The PUT endpoint is the
// mutation used by the stale-data proof (mutate a source entity mid-render and
// assert the PDF matches the snapshot, not the mutation).

const express = require('express');
const { EntityStore } = require('./store');
const { makeEntities } = require('../fixtures/generator');

const PORT = parseInt(process.env.MOCK_ERP_PORT || '4000', 10);
const SEED = parseInt(process.env.MOCK_ERP_SEED || '42', 10);
const PO_COUNT = parseInt(process.env.MOCK_ERP_PO_COUNT || '120', 10);

const store = new EntityStore();
const { purchaseOrders, invoices } = makeEntities(SEED, PO_COUNT);
store.seed('purchase-orders', purchaseOrders);
store.seed('invoices', invoices);

const app = express();
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mock-erp',
    seed: SEED,
    counts: {
      purchaseOrders: store.list('purchase-orders', { limit: 1 }).total,
      invoices: store.list('invoices', { limit: 1 }).total,
    },
  });
});

// Generic CRUD router shared by both entity kinds.
function crudRouter(kind) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const offset = parseInt(req.query.offset || '0', 10);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    res.json(store.list(kind, { offset, limit }));
  });

  router.get('/:id', (req, res) => {
    const entity = store.get(kind, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    res.json(entity);
  });

  router.post('/', (req, res) => {
    try {
      res.status(201).json(store.create(kind, req.body));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // The mutation endpoint (shallow merge; id immutable; updatedAt bumped).
  router.put('/:id', (req, res) => {
    const updated = store.update(kind, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    if (!store.remove(kind, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return router;
}

app.use('/purchase-orders', crudRouter('purchase-orders'));
app.use('/invoices', crudRouter('invoices'));

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'info', msg: 'mock-erp listening', port: PORT, seed: SEED,
    purchaseOrders: purchaseOrders.length, invoices: invoices.length,
  }));
});
