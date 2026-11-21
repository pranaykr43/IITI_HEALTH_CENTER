#!/usr/bin/env bash
# Nightly reset for a public showcase deployment (NODE_ENV=demo): discard everything
# visitors changed and reload the synthetic showcase data. Refuses to run in production.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
grep -q '^NODE_ENV=demo$' .env || { echo 'Refusing to reset: .env is not a showcase (NODE_ENV=demo) deployment.' >&2; exit 1; }
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

echo "$(date -u +%FT%TZ) resetting showcase data"
$DOCKER compose stop worker web
$DOCKER compose run --rm --no-deps -T web sh -c 'rm -f /var/lib/health/data/health-centre.sqlite /var/lib/health/data/health-centre.sqlite-wal /var/lib/health/data/health-centre.sqlite-shm'
$DOCKER compose up -d web
for _ in $(seq 1 30); do
  $DOCKER compose exec -T web node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 2
done
$DOCKER compose exec -T web node scripts/seed-showcase.js >/dev/null
$DOCKER compose up -d worker
echo "$(date -u +%FT%TZ) showcase reset complete"
