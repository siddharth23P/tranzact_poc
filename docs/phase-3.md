# Phase 3 — Render worker: BrowserPool + SinglePass + SHA-256 + manifest + presigned URL

## What this phase delivers

- **BrowserPool** (`src/browserPool.js`): one warm Chromium, a fixed pool of `N`
  reusable pages handed out **page-per-task**. `acquire()` blocks FIFO when all
  pages are busy; `release()` resets the page (and replaces a poisoned one so it
  can't wedge the pool). Warming pages up front keeps per-render latency low.
- **SinglePass render** (`src/render/singlePass.js` + `src/render/template.js`):
  builds the purchase-order HTML and prints it to a PDF in one pass. **Every
  user-supplied field is HTML-escaped** through the single choke point
  `src/render/escape.js` — a document containing `<script>`, `"`, `'`, `&`, `` ` ``
  cannot break out of its text/attribute context.
- **Integrity seal**: SHA-256 computed over the exact rendered PDF bytes.
- **Manifest write through `manifest_writer`** (`src/manifest.js`): the per-
  artifact row (`sha256`, `artifact_key`, `byte_size`, ...) is inserted via the
  restricted append-only pool.
- **Delivery**: presigned GET URL for the artifact
  (`s3.presignGet`, `@aws-sdk/s3-request-presigner`).
- **Worker** (`src/worker.js`): two BullMQ Workers over one shared BrowserPool —
  `render-single` at concurrency `N`, `render-bulk` capped at `N-k` so `k` pages
  are always free for the single fast lane (the reserved-capacity guarantee from
  `docs/queueing.md`). Per task: **guard on job state** (only render
  `queued`/`processing` jobs — the all-or-nothing guard), load the snapshot
  (cached per job — workers render **only** from the snapshot), render + seal +
  manifest, increment Redis progress, and on the last document **flush** counters
  to the jobs row (single winner via a Redis `SET NX` finalize marker).
- **Partial failure**: a per-document render error records an `error` manifest
  entry and increments the `failed` counter instead of throwing — so a bulk job
  finalizes at e.g. 99/100 with the failure captured in the manifest.

## Composition mapping

`renderDocument` (`src/render/pipeline.js`) is the composed unit: `RenderStrategy`
(SinglePass) → `IntegritySealer` (SHA-256) → artifact store → `Sha256Manifest`.
The worker wires these over the `SnapshotProvider` (S3Snapshot) and progress. No
`BulkJob` type — the worker treats every task identically; "bulk" is just a job
with N tasks landing on the bulk queue.

## Smoke test (renders one PO end-to-end)

```bash
# with docker compose (real Chromium in the image):
docker compose up -d --build
docker compose exec worker npm run smoke:render

# or locally (see tools/local-infra/up.sh), with a Chromium path:
CHROMIUM_PATH=/path/to/chromium node pdf-service/scripts/smoke-render.js
```

It prints the manifest row + presigned URL, then re-downloads the stored PDF,
re-hashes it, and asserts the bytes are a PDF whose SHA-256 and size match the
manifest.

## Authoring-environment verification (actually run)

Rendered against local Postgres 16 + Redis 7 + s3rver, using the preinstalled
Playwright Chromium (`/opt/pw-browsers/chromium`), since the MinIO/Chromium
images were unpullable. Observed:

| Check | Result |
|---|---|
| `escape.js` — `<script>`, `<img onerror>`, `"`, `&` in user data | escaped; no raw tags in HTML |
| `smoke:render` single PO | rendered ~175ms; manifest row written via `manifest_writer`; presigned URL issued |
| integrity | stored artifact is `%PDF-`; re-hash == manifest sha256; byte_size matches |
| full queue path (API + worker, bulk×3) | worker consumed all 3; `status=completed`, `completed=3`; 3 rendered manifest rows with distinct hashes |
| progress flush | `progressSource` went `redis` → `postgres` after terminal finalize |

> ⚠️ As in earlier phases, the `docker compose` stack itself was **not** run in
> the authoring environment (image pulls blocked). The Docker image installs the
> Debian `chromium` package and points `CHROMIUM_PATH=/usr/bin/chromium`; the app
> code path is identical to what was exercised locally.

## Notes / flags (proceeding as specified)

- **One image for api + worker.** The worker needs Chromium; the api doesn't, but
  it inherits it. Simpler build at the cost of a fatter api image. Would split
  into two images (or a multi-stage target) for production.
- **Per-document render errors are not retried.** They're recorded as `error`
  manifest entries (partial-failure semantics). Transient Chromium crashes could
  benefit from a bounded BullMQ retry; deferred until the phase-7 chaos scenario
  informs the retry policy.
