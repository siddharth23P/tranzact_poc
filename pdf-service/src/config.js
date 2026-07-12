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

  db: {
    host: required('POSTGRES_HOST', 'localhost'),
    port: parseInt(required('POSTGRES_PORT', '5432'), 10),
    database: required('POSTGRES_DB', 'pdf_service'),
    // Owner/migration role — full DDL rights.
    user: required('POSTGRES_USER', 'pdf'),
    password: required('POSTGRES_PASSWORD', 'pdf'),
  },

  // Restricted, append-only manifest writer role. Created by migrations with
  // INSERT + SELECT on manifest_entries only (no UPDATE/DELETE grants).
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
};

module.exports = config;
