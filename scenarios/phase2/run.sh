#!/usr/bin/env bash
# POST /jobs + GET /jobs/{id} verification suite.
# Assumes the API is reachable at $BASE (default localhost:3000) with Redis +
# Postgres + S3 behind it (docker compose up, or tools/local-infra/up.sh).
#
#   ./scenarios/phase2/run.sh
set -uo pipefail

BASE="${BASE:-localhost:3000}"
DIR="$(cd "$(dirname "$0")" && pwd)/payloads"
J="content-type: application/json"

say() { printf '\n=== %s ===\n' "$1"; }
post() { curl -s -w " [HTTP %{http_code}]\n" -X POST "$BASE/jobs" -H "$J" -d @"$DIR/$1"; }

say "health / ready"
curl -s "$BASE/health"; echo
curl -s "$BASE/ready"; echo

say "1. valid single (expect 201, priority=single, status=queued)"
post single.json

say "2. valid bulk x3 (expect 201, priority=bulk, status=queued)"
post bulk.json

say "3. empty documents [] (expect 400)"
post empty.json

say "4. 101 documents (expect 400, clean max error)"
post oversize_101.json

say "5. malformed docs (expect 400 with per-document errors)"
post malformed.json

say "6. idempotency: same key twice (expect same id; 201 then 200 idempotent:true)"
R1=$(curl -s -X POST "$BASE/jobs" -H "$J" -d @"$DIR/idempotent.json")
R2=$(curl -s -X POST "$BASE/jobs" -H "$J" -d @"$DIR/idempotent.json")
ID1=$(printf '%s' "$R1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
ID2=$(printf '%s' "$R2" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "1st id=$ID1 idempotent=$(printf '%s' "$R1"|node -pe 'JSON.parse(require("fs").readFileSync(0)).idempotent')"
echo "2nd id=$ID2 idempotent=$(printf '%s' "$R2"|node -pe 'JSON.parse(require("fs").readFileSync(0)).idempotent')"
[ "$ID1" = "$ID2" ] && echo "PASS same id" || echo "FAIL different ids"

say "7. GET /jobs/{id} (expect 200, progressSource)"
curl -s -w " [HTTP %{http_code}]\n" "$BASE/jobs/$ID1"

say "8. GET unknown / non-uuid (expect 404)"
curl -s -w " [HTTP %{http_code}]\n" "$BASE/jobs/00000000-0000-0000-0000-000000000000"
curl -s -w " [HTTP %{http_code}]\n" "$BASE/jobs/not-a-uuid"
