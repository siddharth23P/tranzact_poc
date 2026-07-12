'use strict';

// Idempotent forward-only migration runner.
// - Applies every migrations/*.sql not yet recorded in schema_migrations,
//   each in its own transaction.
// - Then reconciles the restricted, append-only manifest_writer role and its
//   grants (kept in code so the role password never lands in a tracked file).
//
// Safe to run repeatedly and on every API boot.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet(client) {
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function applySqlFiles(client) {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const done = await appliedSet(client);

  for (const file of files) {
    if (done.has(file)) {
      logger.debug('migration already applied', { file });
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    logger.info('applying migration', { file });
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info('migration applied', { file });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('migration failed', { file, error: err.message });
      throw err;
    }
  }
}

// Reconcile the append-only manifest writer role. Idempotent: run every boot.
// Grants are INSERT + SELECT only; UPDATE/DELETE/TRUNCATE are explicitly
// revoked so the append-only property holds at the database layer.
async function ensureManifestRole(client) {
  const roleName = config.manifestDb.user;
  const password = config.manifestDb.password;

  // Identifiers/literals interpolated safely: role name is validated, password
  // is escaped for a SQL string literal.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(roleName)) {
    throw new Error(`Invalid manifest role name: ${roleName}`);
  }
  const pwLiteral = `'${String(password).replace(/'/g, "''")}'`;

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${roleName}') THEN
        CREATE ROLE ${roleName} LOGIN PASSWORD ${pwLiteral};
      ELSE
        ALTER ROLE ${roleName} LOGIN PASSWORD ${pwLiteral};
      END IF;
    END
    $$;
  `);

  // Baseline: allow connecting and reading the schema catalog.
  await client.query(`GRANT CONNECT ON DATABASE ${config.db.database} TO ${roleName};`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${roleName};`);

  // Append-only surface: SELECT + INSERT on the ledger and its sequence.
  await client.query(`GRANT SELECT, INSERT ON manifest_entries TO ${roleName};`);
  await client.query(`GRANT USAGE, SELECT ON SEQUENCE manifest_entries_id_seq TO ${roleName};`);

  // Belt and suspenders: strip any mutation rights that could grant append-only
  // a way out. (Also guards against a role that pre-existed with wider grants.)
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON manifest_entries FROM ${roleName};`);

  // The writer must NOT be able to mutate jobs either — no grants there at all.
  await client.query(`REVOKE ALL ON jobs FROM ${roleName};`);

  logger.info('manifest_writer role reconciled', { role: roleName });
}

async function run() {
  const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: 2,
  });

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    await applySqlFiles(client);
    await ensureManifestRole(client);
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = { run };

// Allow standalone execution: `node src/migrate.js`
if (require.main === module) {
  run()
    .then(() => {
      logger.info('migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error('migrations failed', { error: err.message });
      process.exit(1);
    });
}
