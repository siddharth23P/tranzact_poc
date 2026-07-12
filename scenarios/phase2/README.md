# scenarios/phase2 — POST /jobs verification suite

Payloads and a curl harness for the phase-2 API. The payloads double as the
seed of the phase-6 fixture matrix (valid purchase orders with parameterized
line-item counts, plus the rejection edge cases).

## Files

- `gen.js` — deterministic payload generator (re)writing `payloads/*.json`. Also
  exports `purchaseOrder(i, lineItemCount)` / `bulk(n, extra, lineItemCount)` for
  reuse by later phases.
- `payloads/` — committed fixtures: `single`, `bulk`, `idempotent`, `empty`,
  `oversize_101`, `malformed`.
- `run.sh` — the full request suite against a running API.

## Run

```bash
# with docker compose up (real MinIO):
BASE=localhost:3000 ./scenarios/phase2/run.sh

# or docker-free (see tools/local-infra/up.sh), then:
BASE=localhost:3000 ./scenarios/phase2/run.sh

# regenerate fixtures:
node scenarios/phase2/gen.js
```
