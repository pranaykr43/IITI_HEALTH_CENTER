#!/usr/bin/env bash
# Safe update: verified backup first, fast-forward to the latest commit, rebuild, restart,
# and confirm /readyz. Prints a rollback command if the new version does not come up.
#   bash /opt/health-centre/app/deploy/update.sh [branch]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
cd "$APP_DIR"
[[ -f .env ]] || { echo 'No .env found; run deploy/install.sh first.' >&2; exit 1; }
HOST="$(grep '^PUBLIC_HOST=' .env | cut -d= -f2-)"
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

previous="$(git rev-parse --short HEAD)"
echo "==> Current version $previous"

echo '==> Taking a verified backup before updating'
backup_dir="$(grep '^BACKUP_HOST_DIR=' .env | cut -d= -f2- || true)"
if [[ "$DOCKER" == "sudo docker" ]]; then
  sudo BACKUP_HOST_DIR="${backup_dir:-/opt/health-centre/backups}" bash scripts/run-host-backup.sh
else
  BACKUP_HOST_DIR="${backup_dir:-/opt/health-centre/backups}" bash scripts/run-host-backup.sh
fi

echo "==> Fetching $BRANCH"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git pull --quiet --ff-only origin "$BRANCH"
current="$(git rev-parse --short HEAD)"
if [[ "$current" == "$previous" ]]; then
  echo "Already up to date ($current)."
  exit 0
fi
echo "==> Updating $previous -> $current"
git --no-pager log --oneline "$previous..$current" | head -20

$DOCKER compose build
$DOCKER compose up -d

for _ in $(seq 1 36); do
  if curl -fsS --max-time 5 "https://$HOST/readyz" >/dev/null 2>&1; then
    echo "==> https://$HOST is healthy on $current."
    exit 0
  fi
  sleep 5
done

echo "The new version did not become ready. Recent logs:" >&2
$DOCKER compose logs --tail=60 web >&2 || true
cat >&2 <<ROLLBACK
Roll back with:
  cd $APP_DIR && git checkout $previous && $DOCKER compose build && $DOCKER compose up -d
Database migrations only move forward; if the new version migrated the database, restore the
backup taken above with npm run db:restore (see docs/backup-and-restore-production.md).
ROLLBACK
exit 1
