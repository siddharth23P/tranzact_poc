'use strict';

// Phase 1 placeholder. Phase 6 replaces this with entity CRUD (including a
// mutation endpoint) + fixtures/generator.js (seeded faker, parameterized
// line-item count). For now it only serves a health check so the compose
// topology is complete and reachable.

const express = require('express');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.MOCK_ERP_PORT || '4000', 10);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mock-erp' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg: 'mock-erp listening', port: PORT }));
});
