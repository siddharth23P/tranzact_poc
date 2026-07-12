# Phase 4 — ChunkedMerge strategy + selection threshold

## What this phase delivers

- **Per-task strategy selection** (`src/render/selectStrategy.js`): a document
  renders via **ChunkedMerge** when `lineItems.length > CHUNK_THRESHOLD`,
  otherwise **SinglePass**. Chosen per document, so a bulk job can mix both.
  `CHUNK_THRESHOLD` and `CHUNK_SIZE` are env-tunable (set from stress data).
- **ChunkedMerge** (`src/render/chunkedMerge.js`): splits line items into
  row-chunks of `CHUNK_SIZE`, renders each chunk with the **same escaped
  template**, and stitches the chunk PDFs with **pdf-lib**. Correctness:
  - **continuous page numbers** ("Page X of Y") stamped **after** the merge over
    the whole document — so numbering is continuous regardless of how chunks fell
    across pages;
  - **continuous line numbering** across chunks (per-chunk `startIndex` offset);
  - the **grand total** is computed over ALL items and shown only on the last
    chunk.
  Chunks render sequentially on the single task-held page — page-per-task holds.

## Clarifications from phase-3 review (resolved here)

### 1. Reservation invariant — now structural

> **BrowserPool size N; k pages reserved for the single lane; the pool grants a
> bulk page only while `bulkInFlight < N−k`, so bulk never holds more than N−k
> pages concurrently and ≥ k pages are always free for singles — enforced on
> `acquire()` with an `assert`, independent of BullMQ worker concurrency.**

Previously the cap was only a convention across two worker `concurrency`
settings. Now `BrowserPool` is lane-aware (`acquire('single'|'bulk')`): a
`bulkInFlight` counter gates bulk grants at `N−k` and single waiters are served
before bulk. `scripts/prove-reservation.js` demonstrates: with N=3/k=1, a third
concurrent bulk acquire blocks while a single acquire still gets its reserved
page immediately.

### 2. Template injection is inert

Mechanism: **JavaScript template literals** in `src/render/template.js`, never a
`{{ }}` engine and never `eval`/`Function` over user input. `${...}`
interpolation happens once, at author time, over the template *source*; user
values enter only as the *result* of `escapeHtml(value)` — ordinary string data.
So user data containing `${payload}` (not re-interpolated) or `{{payload}}` (no
engine to interpret it) renders as literal text. Fixtures `injection.json`
(+ `injectionDoc()`), proof `scripts/prove-injection.js` renders both payloads
and asserts they survive as literal text in the browser-parsed `innerText`.

### 3. `completed_with_errors` terminal state

Migration `002` adds `completed_with_errors` to the status constraint.
`progress.terminalStatus(completed, failed)`:
`completed===0 → failed`; `failed>0 → completed_with_errors`; else `completed`.
The worker's terminal flush uses it, and the rendered/failed counts are on the
job row (`completed_documents`/`failed_documents`). Proof:
`scripts/prove-terminal-status.js`.

## Verify

```bash
# strategy + continuous page numbers (extracts text with pdfjs):
CHROMIUM_PATH=/path/to/chromium CHUNK_THRESHOLD=50 CHUNK_SIZE=40 \
  node pdf-service/scripts/prove-chunked-merge.js

# reservation invariant (structural):
CHROMIUM_PATH=/path/to/chromium node pdf-service/scripts/prove-reservation.js

# injection inert:
CHROMIUM_PATH=/path/to/chromium node pdf-service/scripts/prove-injection.js

# terminal status:
node pdf-service/scripts/prove-terminal-status.js   # needs Postgres+Redis

# via docker compose:
docker compose exec worker npm run prove:chunked-merge
docker compose exec worker npm run prove:reservation
docker compose exec worker npm run prove:injection
docker compose exec worker npm run prove:terminal-status
```

## Authoring-environment verification (actually run)

Local Postgres/Redis/s3rver + Playwright Chromium:

| Check | Result |
|---|---|
| selection: 120-item → ChunkedMerge, 3-item → SinglePass | ✓ |
| merged PDF valid, multi-page | ✓ 6 pages, 121 KB |
| **continuous page numbers** | ✓ "Page 1 of 6" … "Page 6 of 6" (pdfjs-extracted) |
| continuous line numbering across chunks | ✓ rows 1…120 present |
| reservation structural (N=3,k=1) | ✓ 3rd bulk blocks, single still served, bulk resumes after release |
| injection inert | ✓ `{{payload}}` / `${payload}` literal in HTML + browser innerText |
| terminal status | ✓ `terminalStatus` cases; integration → `completed_with_errors` with 1/1 counts |
| end-to-end via worker (large doc) | ✓ worker picked ChunkedMerge, job completed |

> ⚠️ Standing caveat: the `docker compose` stack itself was not run here (image
> pulls blocked). Code path is identical; compose commands provided above.

## Notes / flags (proceeding as specified)

- **Repeated header per chunk group.** Each chunk renders the full PO header
  (vendor/buyer/PO number). Continuous page numbers + totals-on-last-chunk are
  correct; a "continued" header variant is a cosmetic follow-up.
- **`CHUNK_THRESHOLD`/`CHUNK_SIZE` defaults (50/40)** are placeholders — tune from
  phase-7 stress data. Selection is per-document and env-driven, so tuning is a
  config change, no code.
