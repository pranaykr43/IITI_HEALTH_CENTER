#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_dir="${BACKUP_DIR:-/var/lib/health/backups}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
if ! [[ "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Backup failed: BACKUP_RETENTION_DAYS must be a positive integer.' >&2
  exit 1
fi
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/health-centre-$stamp.sqlite"
npm run db:backup -- "$target"
find "$backup_dir" -maxdepth 1 -type f -name 'health-centre-*.sqlite' -mtime "+$retention_days" -delete
echo "Daily database backup completed; retention is ${retention_days} days."
