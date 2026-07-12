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
| 2026-07-12 | Large-PO ChunkedMerge render (120 items) | ~121 KB / 6 pages | `CHUNK_THRESHOLD=50 CHUNK_SIZE=40`; 3 chunk renders + pdf-lib stitch; wall-time not yet recorded as a clean number — pending phase-7. |

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
