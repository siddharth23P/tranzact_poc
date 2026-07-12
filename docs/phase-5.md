# Phase 5 — Delivery: manifest endpoint + lazy zip fallback

## What this phase delivers

- **`GET /jobs/{id}/manifest`** (`src/delivery.js`, `src/routes/delivery.js`):
  per-document entries — presigned URL + `sha256` + `byteSize` +
  `renderStrategy` for rendered docs, `error` message for failed ones — plus
  job-level counts (live Redis while rendering, flushed row at terminal) and the
  snapshot's real S3 `LastModified` timestamp. Presign expiry from
  `PRESIGN_EXPIRY_SECONDS` (default **4 h**). Because the ledger is append-only,
  a retried document can have several rows; the **latest row per index** is
  authoritative (`latestPerDocument`).
- **`POST /jobs/{id}/manifest/refresh`**: re-signs URLs for a **terminal** job
  (`409 job_not_terminal` otherwise).
- **`GET /jobs/{id}/archive`** (`src/archive.js`): lazy zip. First call builds
  `archives/{jobId}.zip` — artifacts **streamed one at a time** from S3 through
  `archiver` into a streaming S3 upload (`@aws-sdk/lib-storage`), never
  buffering all files — then `302`-redirects to the archive's presigned URL.
  Subsequent calls redirect straight to the cached object. A Redis `SET NX`
  lock serializes concurrent first calls. The zip embeds **`MANIFEST.json`**
  (manifest minus URLs) so a partial archive (99/100) is self-describing:
  failed docs are recorded there with their error messages.
- **Bucket CORS** for browser fetches of presigned URLs: wired in compose via
  `MINIO_API_CORS_ALLOW_ORIGIN=${CORS_ALLOW_ORIGIN:-*}`; AWS-S3 policy JSON in
  `docs/api.md`.
- **Client contract** documented in [`docs/api.md`](api.md).

## Phase-4 review items (resolved this round)

1. **Equivalence proof** (`npm run prove:equivalence`): the SAME 600-row PO
   forced through both strategies. Made possible by making pagination
   **deterministic in the template**: line items are split into fixed-height
   sheets of `ROWS_PER_PAGE` rows (one sheet = exactly one PDF page; fixed row
   heights, no wrapping), and ChunkedMerge snaps its chunk size up to a whole
   number of sheets — so both strategies emit the identical sheet sequence.
   **SinglePass page numbers**: previously it had none (only ChunkedMerge
   stamped post-merge). Reconciled: both strategies now pass their final bytes
   through the same `src/render/stamp.js` — footers identical by construction.
   Measured (local, warm page): SinglePass 267,539 B / 20 pages / ~980 ms;
   ChunkedMerge 230,648 B / 20 pages / ~971 ms; **every page text-identical**,
   `Total` exactly once each, row 1 / row 600 in place.
2. **Strategy on the manifest row**: it did **not** exist in `001` (logs only) —
   added as a new nullable `render_strategy` column in migration
   `003_render_strategy.sql`. Table-level grants mean `manifest_writer`'s
   INSERT already covers it; append-only unchanged.
   Schema line: `render_strategy TEXT CHECK (render_strategy IN ('SinglePass','ChunkedMerge') OR render_strategy IS NULL)`.
3. **Header on every chunk/page**: with sheet-based pagination every sheet
   carries its own table header (and a compact "continued" title after page 1).
   Asserted per-page by text extraction inside `prove-equivalence.js`.

## Verify

```bash
docker compose up -d --build

# create a bulk job, wait for completed
curl -s -X POST localhost:3000/jobs -H 'content-type: application/json' \
  -d @scenarios/phase2/payloads/bulk.json
curl -s localhost:3000/jobs/<id>

# manifest: per-doc URL + sha256 + strategy, counts, snapshot timestamp
curl -s localhost:3000/jobs/<id>/manifest | jq .

# download a presigned URL and verify the hash matches manifest sha256
curl -s -o doc0.pdf "<documents[0].url>" && sha256sum doc0.pdf

# refresh (terminal jobs only)
curl -s -X POST localhost:3000/jobs/<id>/manifest/refresh | jq .urlsExpireAt

# archive: first call builds + redirects; second redirects to cache
curl -sL -o job.zip localhost:3000/jobs/<id>/archive
python3 -m zipfile -l job.zip        # MANIFEST.json + NNN_<docId>.pdf per rendered doc

# review-item proofs
docker compose exec worker npm run prove:equivalence
```

## Authoring-environment verification (actually run)

Local Postgres/Redis/s3rver + Playwright Chromium:

| Check | Result |
|---|---|
| equivalence (600 rows) | ✓ 20 pages both; page-for-page identical text; Total ×1 each; headers + continuous footers on all pages |
| manifest | ✓ counts 3/0, snapshot S3 timestamp, 4 h expiry, per-doc URL/sha/strategy |
| presigned download | ✓ bytes hash == manifest sha256 |
| refresh | ✓ 200 on terminal job |
| archive first call | ✓ built + 302, 125 KB zip, 108 ms |
| archive second call | ✓ cached redirect, 18 ms |
| zip contents | ✓ MANIFEST.json + `000_DOC-0.pdf` … `002_DOC-2.pdf` |
| partial failure (1 good + 1 poisoned doc via real worker) | ✓ `completed_with_errors`, counts 1/1, manifest error entry, zip = 1 PDF + MANIFEST.json noting the error |

> ⚠️ Standing caveat: compose itself not run here (image pulls blocked); MinIO
> CORS env is wired but exercised only as documented config.

## Notes / flags (proceeding as specified)

- **`archiver` pinned to v7**: v8 (what npm resolves for `^`-latest) removed the
  classic callable API. See `docs/dead-ends.md`.
- **GET manifest also re-signs on every read** (presigning is stateless), so
  `refresh` is strictly-speaking an alias with a terminal-state guard. It exists
  as an explicit contract point for clients that persist manifests.
- **Template layout changed** in this round (fixed-height sheets, ellipsized
  overflow instead of wrapped rows). Descriptions longer than one line are now
  clipped with `…` — acceptable for the PO layout; flag if wrapping matters.
