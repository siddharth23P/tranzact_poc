'use strict';

// API entrypoint: run migrations to convergence, then serve.
// Migrations run on boot so a fresh `docker compose up` is self-provisioning.

const config = require('./config');
const logger = require('./logger');
const migrate = require('./migrate');
const db = require('./db');
const { createApp } = require('./app');

async function waitForDb(retries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await db.ping();
      return;
    } catch (err) {
      logger.warn('waiting for postgres', { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('postgres did not become available in time');
}

async function main() {
  logger.info('api starting', { env: config.env });

  await waitForDb();
  await migrate.run();

  const app = createApp();
  const server = app.listen(config.api.port, () => {
    logger.info('api listening', { port: config.api.port });
  });

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    // Hard exit if graceful close stalls.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('api failed to start', { error: err.message });
  process.exit(1);
});
