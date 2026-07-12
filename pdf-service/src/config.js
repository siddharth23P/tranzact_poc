'use strict';

// Loads .env when present (local runs); in docker-compose env comes from env_file.
require('dotenv').config();

function required(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  serviceRole: process.env.SERVICE_ROLE || 'api',
  logLevel: process.env.LOG_LEVEL || 'info',

  api: {
    port: parseInt(required('API_PORT', '3000'), 10),
  },

  // Shared connection target. The three roles below all connect to the same
  // host/db but with different privileges (least privilege per code path).
  dbHost: required('POSTGRES_HOST', 'localhost'),
  dbPort: parseInt(required('POSTGRES_PORT', '5432'), 10),
  dbName: required('POSTGRES_DB', 'pdf_service'),

  // (1) Owner / migrator role — full DDL. Used ONLY by the boot migration
  // runner (src/migrate.js). Never opened by request-serving code.
  db: {
    host: required('POSTGRES_HOST', 'localhost'),
    port: parseInt(required('POSTGRES_PORT', '5432'), 10),
    database: required('POSTGRES_DB', 'pdf_service'),
    user: required('POSTGRES_USER', 'pdf'),
    password: required('POSTGRES_PASSWORD', 'pdf'),
  },

  // (2) Runtime application role. Reads/writes the jobs table; can only READ
  // the manifest. Used by the API and worker for everything except manifest
  // writes. Cannot INSERT/UPDATE/DELETE manifest rows.
  appDb: {
    user: required('APP_DB_USER', 'pdf_app'),
    password: required('APP_DB_PASSWORD', 'pdf_app_pw'),
  },

  // (3) Restricted, append-only manifest writer role. INSERT + SELECT on
  // manifest_entries only — no UPDATE/DELETE/TRUNCATE, no access to jobs.
  // Used by the runtime manifest-write pool (src/manifest.js).
  manifestDb: {
    user: required('MANIFEST_DB_USER', 'manifest_writer'),
    password: required('MANIFEST_DB_PASSWORD', 'manifest_writer_pw'),
  },

  redis: {
    host: required('REDIS_HOST', 'localhost'),
    port: parseInt(required('REDIS_PORT', '6379'), 10),
  },

  s3: {
    endpoint: required('S3_ENDPOINT', 'http://localhost:9000'),
    region: required('S3_REGION', 'us-east-1'),
    bucket: required('S3_BUCKET', 'pdf-artifacts'),
    accessKey: required('S3_ACCESS_KEY', 'minioadmin'),
    secretKey: required('S3_SECRET_KEY', 'minioadmin'),
    forcePathStyle: required('S3_FORCE_PATH_STYLE', 'true') === 'true',
  },

  mockErpUrl: process.env.MOCK_ERP_URL || 'http://localhost:4000',

  render: {
    // Path to a Chromium/Chrome binary. Docker worker installs Debian chromium
    // at /usr/bin/chromium; locally we point at the preinstalled Playwright one.
    chromiumPath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    // Warm page pool size (N) and pages reserved for the single (fast) lane (k).
    // The bulk worker's concurrency is capped at N-k, so >=k pages are always
    // free for single tasks — the reserved-capacity SLA guarantee (docs/queueing.md).
    poolSize: parseInt(process.env.RENDER_POOL_SIZE || '4', 10),
    singleReserved: parseInt(process.env.RENDER_SINGLE_RESERVED || '1', 10),
    // Presigned URL TTL for delivered artifacts (default 4h).
    presignExpirySeconds: parseInt(process.env.PRESIGN_EXPIRY_SECONDS || '14400', 10),
    // Deterministic pagination: fixed rows per sheet (one sheet = one PDF page).
    rowsPerPage: parseInt(process.env.ROWS_PER_PAGE || '30', 10),
    // ChunkedMerge selection: use it when a document's line-item count exceeds
    // CHUNK_THRESHOLD; render CHUNK_SIZE rows per chunk (snapped up to a whole
    // number of sheets so chunk boundaries align with page boundaries).
    // Threshold tuned from stress data (phase 7).
    chunkThreshold: parseInt(process.env.CHUNK_THRESHOLD || '50', 10),
    chunkSize: parseInt(process.env.CHUNK_SIZE || '120', 10),
  },
};

module.exports = config;
