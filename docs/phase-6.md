# Phase 6 — mock-erp + fixtures + real clients + the stale-data proof

## What this phase delivers

- **mock-erp** (`mock-erp/`): Express stub standing in for the Django ERP.
  In-memory store seeded deterministically (seed 42 → 120 POs + 30 invoices,
  parameterized line-item counts) from `fixtures/generator.js`. Full CRUD for
  `/purchase-orders` and `/invoices` (list/get/post/**put**/delete); **PUT is
  the mutation endpoint** used by the stale-data proof. `GET /health` reports
  seed + counts.
- **fixtures/generator.js**: seeded faker (`faker.seed`), same seed → same
  bytes. Emits the full test matrix as named files under `fixtures/data/` plus
  `_expectations.json` (per-case expected status). Matrix:
  - **renderer**: `rows_0` (reject: empty lineItems), `rows_500`, `rows_1000`,
    `rows_2000` (bounded numerics so the doc total stays under the validated
    cap), `near_limit_description` (110 chars, must render fully)
  - **parser**: `missing_fields`, `quantity_string` ("ten"), `negative_values`,
    `null_fields`, `truncated` (literally broken JSON → `400 invalid_json`),
    `duplicate_doc_ids` (dup documentIds in one bulk → rejected)
  - **injection**: canonical fixture (copied from scenarios/phase2)
  - **limits**: `bulk_100` (accepted, renders 100/100), `bulk_101` (clean 400),
    `empty` (400)
  - **locale**: `indic` (Devanagari + Tamil party names/lines, INR),
    `gst_intrastate` (CGST+SGST, MH→MH), `gst_interstate` (IGST, MH→KA),
    `rounding_edges` (0.005, 9.995, 3×33.333, 0.1+0.2 float artifacts)
- **Trigger client** (`scenarios/client/trigger.js`): submits jobs exactly as
  Django would — reads entities from the ERP, maps to the POST /jobs document
  shape, one JSON request with idempotency key. CLI + reusable module.
- **Download client** (`scenarios/client/download.js`) — the MEGA-style
  client-side assembly path, exercised for real: polls to terminal, fetches the
  manifest, downloads with a **concurrency pool of 4 + per-file retry (2,
  backoff)**, **verifies every sha256**, prints per-file progress and a summary;
  non-zero exit on any failure.
- **Matrix harness** (`scenarios/matrix/run.js`): posts every fixture, asserts
  expected statuses, `--render` waits for accepted jobs to complete.
- **Stale-data proof** (`scenarios/stale-data/run.js`) — see below.
- Worker image now installs `fonts-noto-core` so Indic scripts render with real
  glyphs in the container.

## Race bug found & fixed (thanks to `limits_bulk_100`)

With 100 tasks and an idle worker, tasks were picked up in the window between
`addBulk` and the API's `status='queued'` flip. The worker's all-or-nothing
guard treated `pending` as "not renderable" and **acked the tasks away** — the
job hung at 0/100 with empty queues. Fix: `pending` is a race, not a verdict —
the worker now **throws** so BullMQ requeues (tasks enqueue with
`attempts: 5, backoff: exponential 500ms`); only terminal statuses skip-ack.
Per-document render errors still never throw (recorded as manifest error
entries), so they are NOT retried by this. Verified: `limits_bulk_100` → 100/100.

## The stale-data proof (run for real)

`node scenarios/stale-data/run.js` — self-contained and rerunnable:

1. Resets doc #87's source entity to a known baseline (a previous run's
   mutation must not leak into this run's snapshot).
2. Triggers a bulk of 100 from mock-erp (payload snapshotted at enqueue).
3. At t+2s — mid-render — PUT-mutates #87's source (vendor + description).
   (Default is 2s, not 5s: this rig renders ~20 docs/s so #87 renders ~t+3.3s;
   `MUTATE_AT_MS` env to tune. The script **asserts the ordering** via the
   manifest's `renderedAt`: inconclusive runs fail loudly.)
4. Downloads #87's sealed PDF and asserts it contains the SNAPSHOT values and
   no mutated strings; prints both values; confirms the ERP entity IS mutated.

Observed: mutation at t+2047ms; #87 rendered **1285ms after** the mutation;
PDF contains `"Baseline Steel Works & Co"` / `"BASELINE-SNAPSHOT-VALUE …"`,
zero occurrences of `MUTATED`; ERP live entity shows the mutated values.
**PASSED.**

## Phase-6 review answers

**Q2 — `renderedAt` provenance (correction: NOT a migration).** `renderedAt`
is `manifest_entries.created_at`, which has existed since migration **001**
(`TIMESTAMPTZ NOT NULL DEFAULT now()`); phase 6 only started *exposing* it in
the manifest payload. No schema change was made, so there is no migration 004
and grants are untouched (nothing new to grant — the column was always
readable/insertable under the table-level grants).

**Clocks in the stale-data ordering assert:** the two sides come from
*different clocks*. `renderedAt` is **Postgres `now()`** (DB server clock,
stamped at manifest INSERT); the mutation timestamp is **`Date.now()` of the
host running the scenario script** (captured right after the PUT returns). In
the compose/local setups everything shares one physical machine clock, so the
comparison is sound there; across real hosts it would be exposed to clock
skew. A single-clock version would timestamp the mutation in Postgres too —
noted as a limitation, not built.

## Verify

```bash
docker compose up -d --build         # mock-erp seeds itself on boot

# fixtures
cd mock-erp && npm run generate      # (re)writes fixtures/data/*.json

# CRUD smoke
curl -s localhost:4000/health
curl -s 'localhost:4000/purchase-orders?limit=2'
curl -s -X PUT localhost:4000/purchase-orders/PO-0001 \
  -H 'content-type: application/json' -d '{"vendor":{"name":"Mutated"}}'

# full matrix (19 cases; --render waits for accepted jobs to complete)
node scenarios/matrix/run.js --render

# trigger + download clients (Django-style submit; MEGA-style assembly)
node scenarios/client/trigger.js bulk 100        # prints job id
node scenarios/client/download.js <jobId>        # pool=4, retries, sha256 verify

# the stale-data proof
node scenarios/stale-data/run.js
```

## Authoring-environment verification (actually run)

| Check | Result |
|---|---|
| generator determinism | seed 42 → 120 POs / 30 invoices, matrix = 19 named files |
| CRUD | list/get/post/put/delete + invoices all exercised |
| matrix `--render` | **19/19 passed** (renders incl. 2000-row chunked doc, bulk 100/100, all locale + injection; all parser/limits rejections with clear errors) |
| truncated JSON | `400 invalid_json` (parse errors no longer 500) |
| stale-data proof | PASSED with conclusive ordering (see above) |
| download client | 100/100 downloaded + sha256-verified, pool 4 |
| trigger single/bulk | 201/queued, correct priorities |

> ⚠️ Standing caveats: compose not run here (image pulls blocked); local host
> lacks Indic fonts so `locale_indic` renders with fallback glyphs locally —
> the worker image installs `fonts-noto-core` for real glyph coverage. Render
> completion + hash integrity are asserted either way.
