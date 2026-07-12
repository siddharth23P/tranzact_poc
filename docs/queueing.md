# Queue design decision — priority: single > bulk

## Decision

**Two queues (`render-single`, `render-bulk`) with reserved worker capacity for
singles** — option (b). The worker (phase 3) runs two BullMQ `Worker`s over a
shared `BrowserPool` of `N` warm Chromium pages, and **reserves `k` pages
exclusively for `render-single`**. The bulk worker's effective concurrency is
capped at `N − k`; the single worker can use its `k` reserved pages (and,
opportunistically, any pages the bulk side isn't currently using).

## Why not (a) single queue with BullMQ priority

BullMQ priority only orders the **waiting list** — it decides which job is
*picked next* when a worker becomes free. It does **not** preempt in-flight
work. Under a bulk backlog, all `N` render slots are occupied by
multi-second bulk renders; a newly-arrived single task still has to wait for one
of those bulk renders to finish before any slot frees. With large line-item PDFs
that per-render time is exactly the tail that blows the 5s single SLA. Priority
ordering is necessary but not sufficient: the contention is at the
*concurrency/slot* level, not the queue level, so head-of-line blocking happens
inside the worker, not in the queue.

## Why (b) hard-guarantees the SLA

Reserving `k` pages for singles means a single task never waits behind bulk
work: there is always a slot it is allowed to take within one render cycle
(bounded by a single render's duration, not the whole bulk backlog). This
converts "singles are usually fast" into "a single task starts within one
render slot, always," which is the guarantee the 5s SLA needs. The cost is up to
`k` idle pages when there are no singles — a deliberate trade of a little
throughput for a hard latency bound. (Singles may still borrow bulk's free pages
to reclaim that throughput when no bulk contention exists; the reservation only
bites when both lanes are saturated.)

## Task exhaustion & the missing reconciler (phase-6 review, Q1)

**If the API dies between `addBulk` and the `status='queued'` flip, nothing —
production would need a reconciler.** Precisely: each task of the stuck job
retries 5 times (exponential backoff, ~15 s total) against the never-flipping
`pending` row, then lands in the queue's **failed set**
(`removeOnFail: false`, so it stays inspectable under `bull:render-*:failed`).
No component sweeps the failed set, and no component marks the job row
`failed` — the job sits in `pending` indefinitely and `GET /jobs/{id}` reports
it as such. The missing production piece is a periodic reconciler that:
(a) fails jobs stuck in `pending`/`processing` beyond a deadline,
(b) drains or re-enqueues the failed set, and (c) re-derives per-document
state from the manifest ledger (Postgres) + snapshot (S3) — which together
contain everything needed to resume exactly the missing documents.
Deliberately **not built** in this POC; `scenarios/chaos_flush_redis.js`
demonstrates the same ledger-derived recovery performed by hand.

## Phase-3 implementation sketch

- `BrowserPool` of `N` pages (e.g. `N=4`), `k` reserved (e.g. `k=1–2`, tuned).
- `Worker('render-single', { concurrency: N })` — may grab any free page.
- `Worker('render-bulk',   { concurrency: N - k })` — capped so `k` pages can
  never all be held by bulk.
- Both draw pages from the same pool; the concurrency caps enforce the
  reservation without page pinning.
- `stress_interleave` (phase 7) measures the single-task p95 delta with vs.
  without the reservation to validate the guarantee empirically and tune `k`.
