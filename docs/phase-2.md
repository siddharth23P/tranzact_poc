# Phase 2 — POST /jobs (validate → snapshot → enqueue) + GET /jobs/{id}

## What this phase delivers

- **`POST /jobs`** — creates a single or bulk job. Pipeline, in order:
  1. **Enqueue-time validation** (`src/validation.js`). Every field a document
     needs to render is checked synchronously. Malformed documents are rejected
     in the API response and never reach a worker.
  2. **Persist** the job row (`status='queued'`) with **idempotency-key dedupe**
     (`ON CONFLICT (idempotency_key)`).
  3. **Snapshot** the full validated payload to S3 at
     `snapshots/{jobId}.json` — **before** enqueue. Workers render only from
     this frozen snapshot (bulk consistency).
  4. **Init** live progress counters in Redis (`job:{id}:progress`).
  5. **Enqueue** one BullMQ task per document onto the priority-appropriate
     queue.
- **Two priority queues, single > bulk** (`src/queues.js`): a 1-document job's
  task → `render-single`; a bulk job's N tasks → `render-bulk`. Work is one
  task *per document*, which is what makes per-document progress, per-document
  manifest entries, and partial failure (99/100) fall out naturally in later
  phases.
- **`GET /jobs/{id}`** — status + progress. Live counters come from Redis while
  rendering (`progressSource: "redis"`); after terminal flush, from the jobs row
  (`progressSource: "postgres"`).
- **Priority inferred from document count**: 1 → `single`, 2..100 → `bulk`.
  Empty array and >100 are rejected.

## Phase-2 review fixes (issues 1–3)

1. **Enqueue is all-or-nothing from the job's perspective.** Status lifecycle:
   row inserted as `pending`, promoted to `queued` **only after** the snapshot
   is written and all tasks are enqueued. `enqueueDocuments` uses a single
   `addBulk` with deterministic task ids (`${jobId}-${index}`) and retries on
   partial failure — the ids make the retry converge to exactly N tasks. If it
   still fails, the job is marked `failed` with a clear error and the API returns
   `502`; a worker only renders tasks whose job is `queued`/`processing`, so a
   leaked task on a `failed` job never renders. Proof:
   `npm run prove:enqueue-atomic` (forces enqueue to throw → job `failed`, clean
   502, nothing left `queued`).
2. **Idempotency under concurrency.** Exact order: **insert job row first**
   (unique `idempotency_key` gates) → snapshot → enqueue → `status=queued`. Only
   the creator (`created=true`) snapshots/enqueues; concurrent duplicates return
   the existing job (`200 idempotent:true`), handled via both `ON CONFLICT DO
   NOTHING` and an explicit `23505` catch — the racing loser never gets a 500.
   Verified with 8 concurrent same-key requests: 1 created, 7 replays, same id,
   zero 5xx.
3. **Queue design decided:** two queues with **reserved worker capacity for
   singles** (not single-queue priority). Rationale in `docs/queueing.md` —
   BullMQ priority only orders the waiting list and can't preempt in-flight bulk
   renders, so it can't hard-guarantee the 5s single SLA under a bulk backlog;
   reserving `k` Chromium pages for singles can. Implemented in phase 3.

## Follow-ups from phase-1 review (done in this phase)

1. **Runtime role usage proven, not just role existence.** Three-role model:
   owner/migrator (migrations only), `pdf_app` (runtime jobs r/w, manifest
   read-only), `manifest_writer` (manifest INSERT/SELECT only). Run
   `npm run prove:append-only` (below) to see the app's own code paths do an
   INSERT via the restricted pool, then get denied on UPDATE/DELETE through that
   same pool — and the app pool denied on any ledger write.
2. **Redis progress counters.** Live increments go to a Redis hash; the jobs
   columns are the terminal flush target (`src/progress.js`).
3. Phase-1 compose caveat documented in `docs/phase-1.md`.

## API contract

```
POST /jobs
  body: { "idempotencyKey"?: string, "documents": [ <purchaseOrder>, ... ] }
  201 -> job created         (idempotent:false)
  200 -> idempotent replay   (idempotent:true, same id, no re-enqueue)
  400 -> validation_failed   ({ errors:[...], documents:[{index,documentId,errors:[...]}] })
  502 -> snapshot_failed | enqueue_failed  (job row marked 'failed', nothing enqueued past the failure)

purchaseOrder = {
  documentId: string, poNumber: string,
  type?: "purchase_order",
  vendor: { name: string, ... }, buyer?: object, currency?: string,
  lineItems: [ { description: string, quantity: number>0, unitPrice: number>=0 }, ... ]  // >= 1
}

GET /jobs/{id}
  200 -> { id, status, priority, totalDocuments, completedDocuments,
           failedDocuments, snapshotKey, progressSource, ... }
  404 -> not_found
```

## Verify (docker compose — run on a host with Docker Hub access)

> ⚠️ As in phase 1, the compose stack was **not** run in the authoring
> environment (image pulls blocked). It was verified against local
> Postgres 16 + Redis 7 + an S3 mock; commands and outputs are in the
> "Authoring-environment verification" section below. The `worker` service is
> still a placeholder in phase 2 — enqueued tasks sit in the queue (visible via
> queue depth) until phase 3's render worker consumes them, so jobs stay
> `queued` with 0 progress here. That is expected.

```bash
cp .env.example .env
docker compose up -d --build
curl -s localhost:3000/ready

# --- a valid single job (priority=single) ---
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{
  "documents":[{"documentId":"D1","poNumber":"PO-1","vendor":{"name":"Acme"},
    "lineItems":[{"description":"Widget","quantity":2,"unitPrice":9.99}]}]}'

# --- a valid bulk job (priority=bulk) ---
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{
  "documents":[
    {"documentId":"D1","poNumber":"PO-1","vendor":{"name":"Acme"},"lineItems":[{"description":"W","quantity":1,"unitPrice":5}]},
    {"documentId":"D2","poNumber":"PO-2","vendor":{"name":"Globex"},"lineItems":[{"description":"G","quantity":3,"unitPrice":2}]}]}'

# --- rejections ---
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{"documents":[]}'            # 400 empty
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{"documents":[{"documentId":"x"}]}'  # 400 malformed
# 101 documents -> 400 (generate with jq/node); message: "documents exceeds max of 100 per job (got 101)"

# --- idempotency: same key twice returns the SAME id, second is idempotent:true ---
BODY='{"idempotencyKey":"batch-42","documents":[{"documentId":"D1","poNumber":"PO-1","vendor":{"name":"Acme"},"lineItems":[{"description":"W","quantity":1,"unitPrice":5}]}]}'
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d "$BODY"   # 201 idempotent:false
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' -d "$BODY"   # 200 idempotent:true

# --- GET status ---
curl -s localhost:3000/jobs/<jobId>

# --- snapshot landed in S3 (before enqueue) ---
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null
docker compose exec minio mc ls local/pdf-artifacts/snapshots/

# --- queue depth: single vs bulk ---
docker compose exec redis redis-cli LLEN bull:render-single:wait
docker compose exec redis redis-cli LLEN bull:render-bulk:wait

# --- runtime append-only proof (three roles, real code paths) ---
docker compose exec api npm run prove:append-only
```

## Authoring-environment verification (actually run)

Verified against local **Postgres 16 + Redis 7 + s3rver** (S3 mock, since MinIO
image was unpullable). Observed:

| Case | Result |
|---|---|
| valid single | `201`, `priority:"single"`, snapshot key set |
| valid bulk (3) | `201`, `priority:"bulk"` |
| empty `documents:[]` | `400` `documents must be a non-empty array (got 0)` |
| 101 documents | `400` `documents exceeds max of 100 per job (got 101)` |
| malformed docs | `400` with per-document `{index, documentId, errors[]}` |
| idempotency (same key ×2) | `201 idempotent:false` then `200 idempotent:true`, **same id**, **no re-enqueue** (queue depth unchanged) |
| `GET /jobs/{id}` | `200`, `progressSource:"redis"`, live counters |
| `GET` unknown / non-uuid | `404` |
| snapshot in S3 | `snapshots/{jobId}.json` present, full payload, written before enqueue |
| queue routing | single task → `render-single`, bulk tasks → `render-bulk` |
| snapshot/enqueue failure | job row set to `failed`, nothing enqueued past the failure |
| runtime append-only | writer INSERT ok; UPDATE/DELETE denied; `pdf_app` denied on ledger write |

## Note on inferred priority (flagged, proceeding as specified)

Priority is inferred purely from document count (1 = single lane). If you ever
want a *single-document* job to ride the bulk lane (or a small multi-doc job to
jump the single lane), that isn't expressible today. Easy to add an explicit
`priority` override later; not doing so now since the spec ties priority to the
single-vs-bulk distinction.
