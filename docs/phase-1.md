# Phase 1 — Infra + API skeleton + migrations

## What this phase delivers

- `docker-compose.yml` with the full locked topology: `redis`, `minio`
  (+ `minio-init` to create the artifacts bucket), `postgres`, `mock-erp`,
  `api`, `worker`. `worker` and `mock-erp` are intentional placeholders until
  phases 3 and 6.
- Express **API** (`pdf-service`) with:
  - `GET /health` — liveness (process up).
  - `GET /ready`  — readiness (Postgres reachable).
- **Migrations** applied automatically on API boot (also runnable standalone):
  - `jobs` — mutable job/aggregate state. Progress columns are the *flushed
    terminal snapshot*; live counters live in Redis (see phase 2 / phase-2.md).
  - `manifest_entries` — **append-only** tamper-evident ledger.
  - `schema_migrations` — bookkeeping.
- **Three-role least-privilege model** (reconciled every boot by `migrate.js`):
  - **owner/migrator** (`pdf`) — full DDL. Used **only** by the boot migration
    runner; never opened by request-serving code.
  - `pdf_app` — runtime application role. `SELECT/INSERT/UPDATE` on `jobs`,
    `SELECT`-only on `manifest_entries`. The API/worker serve traffic as this
    role and **cannot** write the ledger.
  - `manifest_writer` — restricted ledger role: `INSERT` + `SELECT` on
    `manifest_entries` only; `UPDATE`/`DELETE`/`TRUNCATE` revoked, no `jobs`
    access. Workers append manifest rows through this role, so append-only is
    enforced *at the database layer*, not by application convention.

## Design note (flagged, proceeding as specified)

Running migrations on every API boot is convenient for a single-instance
take-home but races if you scale the API horizontally (N replicas applying
migrations concurrently). It's safe here because each migration is
transactional and `schema_migrations`-gated, and Postgres serializes the DDL.
For production I'd move migrations to a dedicated one-shot job/init container.
Proceeding with boot-time migrations per the locked design.

## ⚠️ Verification caveat

The full `docker compose` stack was **not executed in the authoring
environment** — outbound image pulls to Docker Hub's CDN
(`production.cloudfront.docker.com`) are blocked there by egress policy, so
`postgres`, `redis`, `minio`, and the `node` base image can't be pulled. The
compose commands below are provided for you to run on a machine with Docker Hub
access.

What *was* verified in the authoring environment, against a locally-installed
**Postgres 16** (not the container): migrations apply and are idempotent; the
`jobs`, `manifest_entries`, `schema_migrations` tables are created; the
`pdf_app` and `manifest_writer` roles get exactly the intended grants; and the
append-only property holds behaviorally (writer INSERT ok; UPDATE/DELETE
denied; app role cannot write the ledger at all). See
`pdf-service/scripts/prove-append-only.js` for the runtime proof.

## Verify

```bash
# 0. Config
cp .env.example .env

# 1. Bring everything up
docker compose up -d --build

# 2. Watch the API apply migrations and start
docker compose logs -f api      # look for "migrations complete" then "api listening"

# 3. Health + readiness
curl -s localhost:3000/health   # {"status":"ok","service":"pdf-service-api"}
curl -s localhost:3000/ready    # {"status":"ready","db":"up"}

# 4. mock-erp placeholder
curl -s localhost:4000/health   # {"status":"ok","service":"mock-erp"}

# 5. Schema is present
docker compose exec postgres psql -U pdf -d pdf_service -c '\dt'
#   expect: jobs, manifest_entries, schema_migrations

# 6. Restricted role exists with the right grants
docker compose exec postgres psql -U pdf -d pdf_service \
  -c "\dp manifest_entries"
#   manifest_writer should show arwd-less UPDATE/DELETE: only r (SELECT) + a (INSERT)

# 7. PROOF the ledger is append-only — these must FAIL for manifest_writer:
docker compose exec postgres psql -U pdf -d pdf_service -c \
  "INSERT INTO jobs (id) VALUES ('00000000-0000-0000-0000-000000000001');"

docker compose exec -e PGPASSWORD=manifest_writer_pw postgres \
  psql -U manifest_writer -d pdf_service -h 127.0.0.1 -c \
  "INSERT INTO manifest_entries (job_id, document_index, status) \
   VALUES ('00000000-0000-0000-0000-000000000001', 0, 'rendered');"      # OK

docker compose exec -e PGPASSWORD=manifest_writer_pw postgres \
  psql -U manifest_writer -d pdf_service -h 127.0.0.1 -c \
  "UPDATE manifest_entries SET status='error' WHERE document_index=0;"    # ERROR: permission denied

docker compose exec -e PGPASSWORD=manifest_writer_pw postgres \
  psql -U manifest_writer -d pdf_service -h 127.0.0.1 -c \
  "DELETE FROM manifest_entries WHERE document_index=0;"                  # ERROR: permission denied

# 8. Tear down
docker compose down -v
```

Success criteria: steps 3–6 return the expected JSON/tables, the `INSERT` in
step 7 succeeds, and both the `UPDATE` and `DELETE` are rejected with
`permission denied`.
