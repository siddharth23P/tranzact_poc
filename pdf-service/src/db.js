'use strict';

const { Pool } = require('pg');
const config = require('./config');

// Runtime application pool — role `pdf_app`. Reads/writes jobs, reads manifest.
// This is what request-serving code (routes, repositories) uses. It has NO
// write access to manifest_entries, so the API path cannot tamper with the
// ledger even by accident.
const appPool = new Pool({
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  user: config.appDb.user,
  password: config.appDb.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Restricted manifest-write pool — role `manifest_writer`. INSERT/SELECT on
// manifest_entries only. Workers append ledger rows through this so the
// append-only guarantee is enforced at the DB grant level: even a compromised
// worker cannot UPDATE or DELETE past manifest entries. Lazily constructed.
let manifestPool = null;
function getManifestPool() {
  if (!manifestPool) {
    manifestPool = new Pool({
      host: config.dbHost,
      port: config.dbPort,
      database: config.dbName,
      user: config.manifestDb.user,
      password: config.manifestDb.password,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return manifestPool;
}

// Builds a short-lived owner/migrator pool. Used ONLY by the migration runner.
// Not exported as a shared singleton so request paths can't accidentally use it.
function buildOwnerPool() {
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: 2,
  });
}

// Readiness ping runs as the runtime app role (what actually serves traffic).
async function ping() {
  const { rows } = await appPool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

async function close() {
  await appPool.end();
  if (manifestPool) await manifestPool.end();
}

module.exports = { appPool, getManifestPool, buildOwnerPool, ping, close };
