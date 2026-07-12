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
  - `jobs` — mutable job/aggregate state with progress counters.
  - `manifest_entries` — **append-only** tamper-evident ledger.
  - `schema_migrations` — bookkeeping.
  - `manifest_writer` — a **restricted DB role** with `INSERT` + `SELECT` on
    `manifest_entries` only; `UPDATE`/`DELETE`/`TRUNCATE` are revoked. This is
    what makes the ledger append-only *at the database layer*, not by
    application convention. Workers write manifest rows through this role.

## Design note (flagged, proceeding as specified)

Running migrations on every API boot is convenient for a single-instance
take-home but races if you scale the API horizontally (N replicas applying
migrations concurrently). It's safe here because each migration is
transactional and `schema_migrations`-gated, and Postgres serializes the DDL.
For production I'd move migrations to a dedicated one-shot job/init container.
Proceeding with boot-time migrations per the locked design.

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
