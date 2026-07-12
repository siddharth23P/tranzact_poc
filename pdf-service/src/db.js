'use strict';

const { Pool } = require('pg');
const config = require('./config');

// Owner pool — used by the API for jobs reads/writes and by the migration
// runner for DDL. Full rights on the schema.
const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Restricted pool — INSERT/SELECT on manifest_entries only. Workers write
// manifest rows through this so append-only is enforced at the DB grant level:
// even a compromised worker cannot UPDATE or DELETE past manifest entries.
// Lazily constructed because phase 1 has no worker traffic yet.
let manifestPool = null;
function getManifestPool() {
  if (!manifestPool) {
    manifestPool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.manifestDb.user,
      password: config.manifestDb.password,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return manifestPool;
}

async function ping() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0].ok === 1;
}

async function close() {
  await pool.end();
  if (manifestPool) await manifestPool.end();
}

module.exports = { pool, getManifestPool, ping, close };
