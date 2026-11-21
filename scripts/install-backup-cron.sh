#!/usr/bin/env bash
set -euo pipefail

repo_dir="${1:-}"
if [[ -z "$repo_dir" || ! -d "$repo_dir" || ! -f "$repo_dir/compose.yaml" ]]; then
  echo 'Usage: sudo bash scripts/install-backup-cron.sh /absolute/path/to/checkout' >&2
  exit 2
fi
repo_dir="$(cd "$repo_dir" && pwd)"
run_user="${SUDO_USER:-$(id -un)}"
user_home="$(getent passwd "$run_user" | cut -d: -f6)"
if [[ -z "$user_home" ]]; then
  echo 'Could not resolve the deployment user home directory.' >&2
  exit 1
fi
cron_file=/etc/cron.d/health-centre-backup
if [[ -e "$cron_file" ]]; then
  echo "$cron_file already exists; review it manually before replacing it." >&2
  exit 1
fi
cat > "$cron_file" <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME="$user_home"
CRON_TZ=UTC
17 2 * * * $run_user cd "$repo_dir" && /bin/bash scripts/run-host-backup.sh >> "$user_home/health-centre-backup.log" 2>&1
EOF
chmod 0644 "$cron_file"
echo 'Daily 02:17 UTC backup scheduled. Confirm the host timezone and inspect /etc/cron.d/health-centre-backup.'
