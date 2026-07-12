'use strict';

const express = require('express');
const db = require('./db');
const logger = require('./logger');
const jobsRouter = require('./routes/jobs');

// Builds the Express app. Kept separate from server.js so it can be imported
// by tests without binding a port.
function createApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // Liveness: process is up. No dependency checks — cheap and always fast.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'pdf-service-api' });
  });

  // Readiness: can we actually reach Postgres? Used by orchestration/probes to
  // decide whether the API should receive traffic.
  app.get('/ready', async (req, res) => {
    try {
      await db.ping();
      res.json({ status: 'ready', db: 'up' });
    } catch (err) {
      logger.warn('readiness check failed', { error: err.message });
      res.status(503).json({ status: 'not_ready', db: 'down', error: err.message });
    }
  });

  // Job creation + status.
  app.use('/', jobsRouter);

  // Delivery: manifest + lazy zip archive.
  app.use('/', require('./routes/delivery'));

  // 404 fallback.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Central error handler. Body-parse failures (malformed/truncated JSON) are
  // client errors — reject with 400, mirroring enqueue-time validation.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.status === 400) {
      return res.status(400).json({ error: 'invalid_json', message: 'request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    logger.error('unhandled request error', { error: err.message, path: req.path });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
