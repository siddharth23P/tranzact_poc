#!/usr/bin/env bash
# Docker-free local infra for verifying the service when Docker Hub image pulls
# are blocked. Brings up Postgres 16 + Redis 7 + s3rver (S3 mock) on localhost
# and prints the env to source before running the API.
#
# Prereqs (Debian/Ubuntu):
#   apt-get install -y postgresql redis-server
#   npm i -g s3rver           # or run via npx
#
# Usage:
#   sudo tools/local-infra/up.sh
#   source /tmp/local.env      # written by this script
#   (cd pdf-service && node src/server.js)
#   BASE=localhost:3000 ./scenarios/phase2/run.sh
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/tmp/pgtest}"

echo "[postgres] init + start ($PGDATA)"
rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown -R postgres:postgres "$PGDATA"
su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/tmp/initdb.log 2>&1
su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p 5432' -l /tmp/pgtest.log start" >/dev/null
sleep 3
su postgres -c "$PGBIN/psql -p 5432 -U postgres -c \"CREATE ROLE pdf LOGIN PASSWORD 'pdf' SUPERUSER;\"" >/dev/null
su postgres -c "$PGBIN/psql -p 5432 -U postgres -c \"CREATE DATABASE pdf_service OWNER pdf;\"" >/dev/null

echo "[redis] start"
redis-server --daemonize yes --port 6379 --dir /tmp >/dev/null
sleep 1; redis-cli ping

echo "[s3rver] start"
( node "$(dirname "$0")/s3rver-launch.js" >/tmp/s3rver.log 2>&1 & )
sleep 3; cat /tmp/s3rver.log

cat > /tmp/local.env <<'EOF'
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 POSTGRES_DB=pdf_service POSTGRES_USER=pdf POSTGRES_PASSWORD=pdf
export APP_DB_USER=pdf_app APP_DB_PASSWORD=pdf_app_pw
export MANIFEST_DB_USER=manifest_writer MANIFEST_DB_PASSWORD=manifest_writer_pw
export REDIS_HOST=127.0.0.1 REDIS_PORT=6379
export S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 S3_BUCKET=pdf-artifacts
export S3_ACCESS_KEY=S3RVER S3_SECRET_KEY=S3RVER S3_FORCE_PATH_STYLE=true
export API_PORT=3000 LOG_LEVEL=info NODE_ENV=development
EOF
echo "[done] source /tmp/local.env, then run the API."
