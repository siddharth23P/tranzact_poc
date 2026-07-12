# API — client contract

Base URL: the `api` service (`http://localhost:3000` in compose).
All bodies are JSON. All ids are UUIDs.

## POST /jobs

Create a render job (1 document = single lane; 2–100 = bulk lane).

```json
{
  "idempotencyKey": "order-batch-42",          // optional
  "documents": [ <purchaseOrder>, ... ]        // 1..100
}
```

`purchaseOrder`:

```json
{
  "documentId": "DOC-1",                        // required
  "type": "purchase_order",                     // optional (default)
  "poNumber": "PO-1001",                        // required
  "vendor": { "name": "Acme", "address": "…" }, // name required
  "buyer":  { "name": "…" },                    // optional
  "currency": "USD",                            // optional
  "lineItems": [                                 // required, >= 1
    { "description": "…", "quantity": 2, "unitPrice": 9.99 }
  ]
}
```

Responses:

| Code | Meaning |
|---|---|
| `201` | created (`idempotent: false`, `status: "queued"`) |
| `200` | idempotency-key replay — the existing job, `idempotent: true`, no re-enqueue |
| `400` | `validation_failed` — request-level `errors[]` + per-document `documents[{index, documentId, errors[]}]`. Nothing was created. |
| `502` | `snapshot_failed` / `enqueue_failed` — job row exists with `status:"failed"`, nothing will render |

Validation happens entirely at enqueue time: a malformed document is rejected
here and never discovered mid-render.

## GET /jobs/{id}

Job status + progress. `progressSource` is `"redis"` while rendering (live
counters) and `"postgres"` after the terminal flush.

Terminal statuses: `completed` (all rendered), `completed_with_errors` (some
failed — e.g. 99/100), `failed` (none rendered or infrastructure failure).

## GET /jobs/{id}/manifest

The delivery manifest — per-file presigned URLs + hashes for client-side
assembly. Available while rendering (documents appear as they finish); URLs are
signed at read time.

```json
{
  "jobId": "…",
  "status": "completed_with_errors",
  "priority": "bulk",
  "counts": { "total": 100, "rendered": 99, "failed": 1 },
  "snapshot": { "key": "snapshots/{id}.json", "createdAt": "2026-07-12T08:16:05.000Z" },
  "urlExpirySeconds": 14400,
  "urlsExpireAt": "2026-07-12T12:16:20.048Z",
  "documents": [
    { "index": 0, "documentId": "DOC-0", "status": "rendered",
      "sha256": "…", "byteSize": 42346, "renderStrategy": "SinglePass",
      "url": "https://…presigned…" },
    { "index": 87, "documentId": "DOC-87", "status": "error",
      "error": "…why this document failed…" }
  ]
}
```

Client contract:

- Download each `url`; **verify the SHA-256 of the received bytes against
  `sha256`** (the hash was computed by the render worker and stored in an
  append-only ledger — a mismatch means corruption or tampering).
- `error` documents have no URL; the job-level `counts` tell you the shape.
- URLs expire at `urlsExpireAt` (`PRESIGN_EXPIRY_SECONDS`, default 4 h).

## POST /jobs/{id}/manifest/refresh

Re-signs the manifest URLs for a **terminal** job (use when a stored manifest's
URLs have expired). Returns the same payload shape as GET. `409
job_not_terminal` before that.

## GET /jobs/{id}/archive

Lazy zip fallback for clients that don't want per-file assembly.

- First call: builds the zip server-side (artifacts streamed from S3 one at a
  time — never buffered wholesale), stores it at `archives/{jobId}.zip`,
  responds `302` to the archive's presigned URL.
- Later calls: `302` straight to the cached object.
- Zip contents: `MANIFEST.json` (same manifest, minus URLs) + one
  `NNN_{documentId}.pdf` per **rendered** document. Failed documents are
  absent as files but recorded in `MANIFEST.json` — a 99/100 archive is
  self-describing.
- `409 job_not_terminal` while rendering; `409 no_artifacts` if nothing
  rendered. Concurrent first calls are serialized by a Redis lock (losers wait
  for the cached object).

`curl -L` follows the redirect; browsers follow it natively.

## CORS (bucket)

Browsers fetching presigned URLs (`documents[].url`, the archive redirect) talk
**directly to the object store**, so the *bucket* endpoint must answer CORS —
API-level CORS does not help.

- **MinIO (compose):** set via env on the `minio` service —
  `MINIO_API_CORS_ALLOW_ORIGIN=${CORS_ALLOW_ORIGIN:-*}` (already wired in
  `docker-compose.yml`; set `CORS_ALLOW_ORIGIN=https://app.example.com` in
  `.env` for a real origin list, comma-separated).
- **AWS S3:** attach a bucket CORS policy instead:

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```

Only `GET`/`HEAD` are needed — clients never write to the bucket; uploads go
through the service.

## Error shape

All errors: `{ "error": "<machine_code>", "message": "<human text>", ... }`.
Codes seen above: `validation_failed`, `not_found`, `job_not_terminal`,
`no_artifacts`, `snapshot_failed`, `enqueue_failed`, `archive_failed`,
`internal_error`.
