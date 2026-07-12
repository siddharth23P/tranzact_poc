'use strict';

// Placeholder worker for phase 1. The real render worker (BrowserPool +
// SinglePass/ChunkedMerge + SHA-256 + manifest write) lands in phase 3.
// For now it simply stays alive so the locked docker-compose topology is
// complete and the container is present in `docker compose ps`.

const logger = require('./logger');

logger.info('worker started (phase 1 placeholder — no queues consumed yet)');

const timer = setInterval(() => {
  logger.debug('worker idle heartbeat');
}, 30000);

const shutdown = (signal) => {
  logger.info('worker shutting down', { signal });
  clearInterval(timer);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
