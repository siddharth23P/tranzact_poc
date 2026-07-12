# Measurements

Running log of performance numbers. **All figures below are indicative, not
SLA numbers** — they were taken in the docker-free authoring environment
(local Postgres/Redis/s3rver + the preinstalled Playwright Chromium), not in the
container topology. Treat them as order-of-magnitude until re-measured under
`docker compose` on real hardware (that's what the phase-7 stress scenarios are
for).

| Date (UTC) | What | Value | Conditions / caveats |
|---|---|---|---|
| 2026-07-12 | Single-PO SinglePass render (`smoke:render`) | ~175 ms | 5-line-item doc; **warm** pooled page (page reuse, not cold launch); local Chromium at `/opt/pw-browsers/chromium`; **no container** (no cgroup limits, host CPU); render only (setContent→`page.pdf`), excludes S3 upload + manifest write; single sample, not a percentile. |
| 2026-07-12 | Large-PO ChunkedMerge render (120 items) | ~121 KB / 6 pages | `CHUNK_THRESHOLD=50 CHUNK_SIZE=40`; pre-pagination-rework template; superseded by the equivalence run below. |
| 2026-07-12 | **Equivalence run, 600-row PO** — SinglePass | 267,539 B / 20 pages / **~980 ms** | `ROWS_PER_PAGE=30`; warm page; includes pdf-lib footer stamping; render-only (no S3/manifest); single sample. |
| 2026-07-12 | **Equivalence run, 600-row PO** — ChunkedMerge | 230,648 B / 20 pages / **~971 ms** | `CHUNK_SIZE=120` (5 chunks × 4 sheets); includes merge + stamping. Page-for-page text identical to SinglePass. |
| 2026-07-12 | Archive (zip) build, 3-doc job | 125 KB, **~108 ms** first call / **~18 ms** cached | streamed build + presign redirect, s3rver local; end-to-end curl wall time. **Caveat: tiny job (3 docs ≈ 42 KB each)** — build time scales with artifact count/bytes; re-measure at 100 docs in phase 7. |
| 2026-07-12 | **Equivalence re-run after wrapped-row rework** (600 rows, 100-char padded descriptions) | SP 337,312 B / CM 274,293 B, **60 pages each**, ~1085 ms / ~965 ms | `ROWS_PER_PAGE=10` (fixed 4-line row boxes); every page text-identical. |

### Summary (phase-5 review)

- 600-row PO ≈ **1 s in both strategies** (~980/~971 ms at 20 single-line-row
  pages; ~1085/~965 ms at 60 pages after the wrapped-row rework). ChunkedMerge
  output is consistently **smaller in bytes** (pdf-lib re-serialization shares
  resources) despite identical page content.
- Archive first-call ~108 ms is a **small-job number** (3 docs), not a general
  figure.

## Caveats that will move these numbers

- **Container overhead:** cgroup CPU/memory limits and `--disable-dev-shm-usage`
  change render latency vs. host.
- **Cold vs warm:** the 175 ms is a warm page. First render after browser launch
  is materially slower (browser + first-page init).
- **End-to-end vs render-only:** the smoke figure is render-only. The full task
  also does SHA-256, S3 PUT, and a manifest INSERT.
- **Percentiles, not means:** phase-7 `stress_burst` records p95 and per-render
  memory under a 50-singles/5s burst; `stress_interleave` records the single-task
  p95 delta with/without the reserved-capacity setting. Those supersede the
  single-sample numbers here.
