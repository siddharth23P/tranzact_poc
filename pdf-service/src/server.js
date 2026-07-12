'use strict';

// API entrypoint: run migrations to convergence, then serve.
// Migrations run on boot so a fresh `docker compose up` is self-provisioning.

const config = require('./config');
const logger = require('./logger');
const migrate = require('./migrate');
const db = require('./db');
const queues = require('./queues');
const redis = require('./redis');
const { createApp } = require('./app');

async function main() {
  logger.info('api starting', { env: config.env });

  // Migrations run as the owner role and internally wait for Postgres; they
  // also create the runtime roles (pdf_app, manifest_writer) this process then
  // uses to serve traffic.
  await migrate.run();

  const app = createApp();
  const server = app.listen(config.api.port, () => {
    logger.info('api listening', { port: config.api.port });
  });

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    server.close(async () => {
      try {
        await queues.close();
        await redis.close();
        await db.close();
      } catch (err) {
        logger.warn('shutdown cleanup error', { error: err.message });
      }
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
