#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backup_dir="${BACKUP_HOST_DIR:-/opt/health-centre/backups}"
mkdir -p "$backup_dir"
cd "$repo_dir"
docker compose exec -T web bash /app/scripts/daily-backup.sh
backup="$(find "$backup_dir" -maxdepth 1 -type f -name 'health-centre-*.sqlite' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
if [[ -z "$backup" ]]; then
  echo 'Backup failed: no timestamped backup file was found.' >&2
  exit 1
fi
if [[ -n "${OCI_BACKUP_BUCKET:-}" ]]; then
  command -v oci >/dev/null || { echo 'OCI upload failed: install and configure OCI CLI first.' >&2; exit 1; }
  oci os object put --bucket-name "$OCI_BACKUP_BUCKET" --name "$(basename "$backup")" --file "$backup" --force >/dev/null
  echo 'Off-VM Object Storage upload completed.'
else
  echo 'No OCI_BACKUP_BUCKET configured; this backup is stored on the VM only.' >&2
fi
