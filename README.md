# PDF Generation Microservice

A horizontally-scalable PDF generation service for an ERP: a stateless Express
API enqueues jobs onto Redis (BullMQ, single > bulk priority), Puppeteer render
workers produce artifacts into S3 (MinIO locally), and job + tamper-evident
manifest state lives in Postgres.

> Build is phased. **Phase 3 (current): render worker (BrowserPool + SinglePass
> + SHA-256 + manifest + presigned URL).** See `docs/phase-1.md` …
> `docs/phase-3.md` for what's implemented and how to verify each phase.

## Architecture (target)

```
client ──▶ API (stateless) ──▶ Redis / BullMQ (single | bulk)
                 │                       │
                 │ snapshot              ▼
                 ▼                 render workers (Puppeteer, BrowserPool)
            S3 / MinIO  ◀──────────────  │  SHA-256 per artifact
          snapshots/{id}.json            ▼
                              Postgres: jobs + append-only manifest_entries
                                         (manifest via restricted DB role)
```

- **Bulk consistency:** full payload snapshotted to `snapshots/{jobId}.json` at
  enqueue; workers render only from the snapshot, never live data.
- **Tamper evidence:** SHA-256 per artifact into an append-only manifest table
  (no UPDATE/DELETE grants — enforced by a restricted DB role).
- **Delivery:** manifest of per-file presigned URLs + hashes (client assembles),
  plus a lazy, cached zip fallback.
- **Composition over inheritance:** a `Job` composes a `SnapshotProvider`,
  `DocumentTask[]`, a per-task `RenderStrategy` (`SinglePass | ChunkedMerge`), an
  `IntegritySealer` (`Sha256Manifest`), and `DeliveryMethod[]`
  (`PresignedManifest | LazyZip`). There is no `BulkJob` — bulk is a `Job` with
  N tasks.

## Layout

```
pdf-service/    Express API + render workers + migrations
mock-erp/       Mock ERP stub (CRUD + fixtures)      — placeholder until phase 6
scenarios/      Proof/stress/chaos harnesses          — phase 7
docs/           Per-phase notes
docker-compose.yml
```

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
curl -s localhost:3000/health
curl -s localhost:3000/ready
```

Full verification (including the append-only ledger proof) is in
[`docs/phase-1.md`](docs/phase-1.md).

## Build phases

1. ✅ infra + API skeleton + migrations
2. ✅ `POST /jobs` (validate + snapshot-to-S3 + BullMQ enqueue) + `GET /jobs/{id}`
3. ✅ Worker: BrowserPool + SinglePass render + SHA-256 + manifest + presigned URL ← current
4. ChunkedMerge strategy + selection threshold
5. Manifest endpoint + lazy zip fallback + progress counters
6. mock-erp: entity CRUD + mutation endpoint + seeded fixtures generator
7. scenarios: stale-data proof, stress_burst, stress_interleave, chaos
```
