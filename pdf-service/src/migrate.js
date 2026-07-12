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
const config = require('./config');
const logger = require('./logger');
const db = require('./db');

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

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Create-or-update a LOGIN role with the given password. Idempotent.
async function ensureRole(client, roleName, password) {
  if (!IDENT.test(roleName)) throw new Error(`Invalid role name: ${roleName}`);
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
}

// Reconcile the two runtime roles. Idempotent: run every boot.
//
//   pdf_app         — reads/writes jobs, reads manifest. NO manifest writes.
//   manifest_writer — INSERT + SELECT on manifest_entries only. No jobs access.
//                     UPDATE/DELETE/TRUNCATE revoked → append-only at DB layer.
//
// The owner/migrator role is deliberately NOT used at runtime; these two are.
async function ensureRuntimeRoles(client) {
  const appRole = config.appDb.user;
  const writerRole = config.manifestDb.user;
  if (!IDENT.test(appRole)) throw new Error(`Invalid role name: ${appRole}`);
  if (!IDENT.test(writerRole)) throw new Error(`Invalid role name: ${writerRole}`);

  await ensureRole(client, appRole, config.appDb.password);
  await ensureRole(client, writerRole, config.manifestDb.password);

  // --- pdf_app: application runtime role ------------------------------------
  await client.query(`GRANT CONNECT ON DATABASE ${config.db.database} TO ${appRole};`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole};`);
  // Full DML on jobs except destructive deletes/truncates.
  await client.query(`GRANT SELECT, INSERT, UPDATE ON jobs TO ${appRole};`);
  await client.query(`REVOKE DELETE, TRUNCATE ON jobs FROM ${appRole};`);
  // Read-only on the ledger; explicitly cannot write it (no tampering path).
  await client.query(`GRANT SELECT ON manifest_entries TO ${appRole};`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON manifest_entries FROM ${appRole};`);

  // --- manifest_writer: append-only ledger role -----------------------------
  await client.query(`GRANT CONNECT ON DATABASE ${config.db.database} TO ${writerRole};`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${writerRole};`);
  await client.query(`GRANT SELECT, INSERT ON manifest_entries TO ${writerRole};`);
  await client.query(`GRANT USAGE, SELECT ON SEQUENCE manifest_entries_id_seq TO ${writerRole};`);
  // Belt and suspenders: no way out of append-only, and no jobs access at all.
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON manifest_entries FROM ${writerRole};`);
  await client.query(`REVOKE ALL ON jobs FROM ${writerRole};`);

  logger.info('runtime roles reconciled', { appRole, writerRole });
}

// Connect the owner pool, retrying until Postgres accepts connections. The
// owner role is the ONLY role used here — runtime roles are created below.
async function connectWithRetry(pool, retries = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      logger.warn('waiting for postgres', { attempt, error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('postgres did not become available in time');
}

async function run() {
  const pool = db.buildOwnerPool();
  const client = await connectWithRetry(pool);
  try {
    await ensureMigrationsTable(client);
    await applySqlFiles(client);
    await ensureRuntimeRoles(client);
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
