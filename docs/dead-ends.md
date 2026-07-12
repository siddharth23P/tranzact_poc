# Dead ends & gotchas

Running log of non-obvious problems hit during development and how they were
resolved, so they aren't re-hit.

## s3rver requires its own fixed credentials

**Context:** Docker Hub image pulls are blocked in the authoring environment, so
local verification uses [`s3rver`](https://www.npmjs.com/package/s3rver) as the
S3 endpoint instead of MinIO.

**Symptom:** `PutObject` failed with
`The AWS Access Key Id you provided does not exist in our records.` even though
the endpoint/region/path-style config was correct.

**Cause:** s3rver enforces auth against a **fixed** access key / secret of
`S3RVER` / `S3RVER` (unlike MinIO, whose root creds are configurable — we use
`minioadmin`/`minioadmin`).

**Fix:** For the local (non-docker) harness only, set
`S3_ACCESS_KEY=S3RVER S3_SECRET_KEY=S3RVER`. The real compose stack uses MinIO
with `minioadmin`. This is a mock-only quirk; app code is unchanged.

## BullMQ custom job ids cannot contain ':'

**Symptom:** `queue.addBulk(...)` threw `Custom Id cannot contain :` and the
enqueue path returned 502.

**Cause:** We set deterministic task ids as `${jobId}:${index}` for de-dupe. `:`
is BullMQ's reserved Redis key delimiter and is rejected in custom job ids.

**Fix:** Join with `-` instead: `${jobId}-${index}` (`src/queues.js`). Still
deterministic, still de-dupes on retry.

## archiver v8 removed the classic callable API

**Symptom:** `GET /jobs/{id}/archive` returned 502 with
`archiver is not a function`.

**Cause:** `npm install archiver` resolved v8, which replaced the classic
`archiver('zip', opts)` factory with class exports
(`{ Archiver, ZipArchive, TarArchive }`).

**Fix:** pinned `archiver@^7` (stable classic API). If upgrading to v8 later,
switch to `new ZipArchive(...)` per its migration notes.

## PDF text extraction sees CSS-uppercased glyphs

**Symptom:** the equivalence proof's "header on every page" check failed even
though headers were visibly present.

**Cause:** the `th` style uses `text-transform: uppercase`, so the PDF contains
the glyphs `DESCRIPTION` / `UNIT PRICE`; a case-sensitive search for
"Description" finds nothing.

**Fix:** case-insensitive assertions when checking extracted PDF text against
CSS-transformed content.

## `pkill -f "src/server.js"` kills the invoking shell

**Symptom:** Commands that ran `pkill -f "src/server.js"` to stop the API exited
with code 144 (128 + SIGTERM) and killed the shell itself.

**Cause:** `pkill -f` matches against the **full command line** of every
process — including the shell currently executing the `pkill` command, whose
argv contains the literal string `src/server.js`. So it SIGTERM'd itself.

**Fix:** Manage the API by PID: capture `$!` at launch into a pidfile and
`kill "$(cat pidfile)"`. Avoid `pkill -f` with a pattern that appears in your
own command line.

## Worker acked tasks for jobs still in 'pending' (enqueue/queued race)

**Symptom:** a 100-doc bulk job hung at 0/100 with empty queues; worker logs
showed `job not renderable, skipping task ... status: pending` for every task.

**Cause:** tasks become visible to the worker at `addBulk`, but the job row is
only flipped to `queued` AFTER enqueue succeeds (deliberate all-or-nothing
ordering). With an idle worker and many tasks, tasks were picked up inside that
window; the state guard treated `pending` like a dead job and ACKED the tasks
away, so they never ran again.

**Fix:** `pending` is a race, not a verdict — the worker now throws for it so
BullMQ requeues the task (tasks enqueue with `attempts: 5`, exponential
backoff); only truly terminal statuses are skip-acked. Small jobs never hit the
window, which is why phases 3–5 didn't catch it; `limits_bulk_100` did.

## Chromium kill produced "detached Frame" errors that bypassed infra classification

**Symptom:** chaos_kill_chromium ended `completed_with_errors` — 3 interrupted
renders were sealed as per-document error entries reading
`Attempted to use detached Frame '…'` instead of being retried.

**Cause:** the infra-vs-document error classifier matched the usual
puppeteer death signatures (`Protocol error`, `Target closed`, …) but not the
detached-frame variant thrown when the browser dies mid-`setContent`/`pdf`.

**Fix:** added `detached frame` / `frame…detached` to INFRA_ERROR_RE so those
throw and BullMQ retries the task. The chaos script now also fails as
INCONCLUSIVE when zero tasks show attemptsMade>1 (kill landed between renders),
so a lucky-timing run can't masquerade as a pass.
