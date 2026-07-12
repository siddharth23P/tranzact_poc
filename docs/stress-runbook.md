# Stress & chaos runbook (phase 7)

Everything here is meant to be executed by **you**, on a machine with Docker
Hub access — the authoring environment cannot run the container stack, and
every headline number must come from inside the capped container. Scripts were
verified mechanically against local (uncapped, non-container) infra; the
"watch first" list at the bottom flags what that could not cover.

**Provenance rule:** every number pasted into `docs/measurements.md` carries
the label from `PROVENANCE` (use `container-2GB`). Scripts print a ready-made
markdown row on completion.

## 0. Cold start

```bash
git clone <repo> && cd tranzact_poc
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d --build
# stress overlay = worker capped at 2 GB (mem+swap), shm 1 GB, restart policy on
docker compose ps                      # all services up
curl -s localhost:3000/ready           # {"status":"ready","db":"up"}
curl -s localhost:4000/health          # mock-erp seeded

cd scenarios && npm i --no-save >/dev/null 2>&1 || true   # scripts have no deps of their own
export PROVENANCE=container-2GB
```

All scripts run from the **repo root** on the host and talk to
`localhost:3000/4000` + docker via `docker compose …`. Memory sampling
defaults to the worker's cgroup file:
`docker compose exec -T worker cat /sys/fs/cgroup/memory.current`
(override with `MEM_CMD` if your engine is cgroup v1 — the fallback path is
attempted automatically).

## 1. stress_burst — 50 singles / 5 s

```bash
PROVENANCE=container-2GB node scenarios/stress_burst.js
```
Reports p50/p95/p99 time-to-presigned-URL vs the 5 s SLA, renders/sec, worker
RSS peak/steady @1 Hz. Paste the emitted row into `docs/measurements.md`.

## 2. stress_interleave — reserved capacity A/B (the headline delta)

Run twice; only the worker env differs:

```bash
# run A: reservation ON (k=1)
RENDER_SINGLE_RESERVED=1 docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d worker
sleep 5
PROVENANCE=container-2GB RUN_LABEL=k1 node scenarios/stress_interleave.js

# run B: reservation OFF (k=0 -> bulk may hold all N pages)
RENDER_SINGLE_RESERVED=0 docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d worker
sleep 5
PROVENANCE=container-2GB RUN_LABEL=k0 node scenarios/stress_interleave.js

# restore
RENDER_SINGLE_RESERVED=1 docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d worker
```

The **single p95 delta k0 vs k1** is the number that justifies (or kills) the
reserved-capacity design. The script warns if bulk pressure ended before the
single window — if so, raise `BULK_JOBS`/`BULK_ROWS` and rerun both labels.
Note: `RENDER_SINGLE_RESERVED=0` also collapses the pool's structural cap
(bulkCap = N), which is exactly the condition being measured.

## 3. oom_probe — sets CHUNK_THRESHOLD

```bash
# probe: force SinglePass regardless of size
CHUNK_THRESHOLD=999999 docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d worker
sleep 5
PROVENANCE=container-2GB node scenarios/oom_probe.js probe
# -> completes 500/1000/…, stops at the first death; reports duration + RSS
#    peak per size and the failure signature (job stuck/failed, OOMKilled flag,
#    restart count, BullMQ failed reasons)

# control: same killer size via ChunkedMerge must survive
CHUNK_THRESHOLD=50 docker compose -f docker-compose.yml -f docker-compose.stress.yml up -d worker
sleep 5
PROVENANCE=container-2GB node scenarios/oom_probe.js control <rows-that-died>
```

**Setting the threshold:** take the last size that completed under SinglePass,
apply a ~2× safety margin, and set `CHUNK_THRESHOLD` in `.env` (e.g. ceiling
2000 → threshold 800–1000). Record both rows in measurements.md.

## 4. chaos_kill_chromium

```bash
PROVENANCE=container-2GB node scenarios/chaos_kill_chromium.js
```
Kills the browser (`pkill -9 chromium` inside the worker container) 3 s into a
20×60-row bulk. PASS = job completes 20/20 with **zero** sealed error entries
(infra errors retry; BrowserPool relaunches) and retry evidence
(`attemptsMade>1`) is printed.

## 5. chaos_flush_redis

```bash
PROVENANCE=container-2GB node scenarios/chaos_flush_redis.js
```
FLUSHALLs Redis at ~40/100 rendered, waits a grace period, then prints the
lost/recovered inventory (lost: queue position, live counters, finalize
marker, de-dupe ids, archive locks; recovered: snapshot, artifacts —
hash-verified — manifest ledger, job row + idempotency key) and finishes with
the **ledger-derived recovery**: counters re-seeded from the manifest, exactly
the missing indexes re-enqueued, job completes 100/100. That recovery is the
reconciler sketch from `docs/queueing.md`, run by hand — and the argument for
Redis-as-coordination-only vs needing SQS-grade durability in the queue.

Use `--no-recover` to leave the stuck job in place for inspection.

## Where numbers land

Append every emitted row to the table in `docs/measurements.md`, keeping the
`container-2GB` provenance label. The authoring-environment rows already there
are labeled as local/uncapped — do not mix them up.

## Watch first (not verifiable in the authoring environment)

- **Memory sampler paths**: cgroup v2 (`/sys/fs/cgroup/memory.current`) vs v1
  fallback inside the worker container — confirm the sampler prints real
  numbers early in stress_burst; otherwise set `MEM_CMD` (last resort:
  `MEM_CMD="docker stats --no-stream --format '{{.MemUsage}}' $(docker compose ps -q worker)"`,
  which is slower than 1 Hz).
- **OOM behavior under the 2 GB cap**: which process the kernel kills
  (Chromium child vs the node worker), whether `OOMKilled=true` shows on the
  container, and how BullMQ reports the stalled/failed task — the probe prints
  all three but the exact signature is machine-dependent.
- **`restart: unless-stopped` interplay** with the probe (worker must come
  back between sizes; if it doesn't, `docker compose up -d worker` manually).
- **pkill match inside the container** (`pkill -9 chromium` matches the Debian
  chromium binary name; verify with `docker compose exec worker pgrep -a chromium`).
- **Interleave pressure**: container render throughput differs from local —
  check the "bulk-still-running" line on both runs before trusting the delta.
- **Indic glyphs** (`locale_indic`): verify visually once in the container
  build (fonts-noto-core installed) — extraction-level checks pass either way.
