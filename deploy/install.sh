#!/usr/bin/env bash
# One-command installer for a fresh Ubuntu 22.04/24.04 VM (ARM64 or x86-64), for example
# an Oracle Cloud Always Free Ampere A1 instance. Read it before running it.
#
#   curl -fsSL https://raw.githubusercontent.com/pranaykr43/IITI_HEALTH_CENTER/main/deploy/install.sh -o install.sh
#   less install.sh
#   bash install.sh --host your-name.duckdns.org [--mode production|showcase]
#
# What it does: installs Docker from Docker's apt repository, opens ports 80/443 in the
# VM firewall, clones the app, writes an owner-only .env with freshly generated secrets,
# builds and starts web + worker + Caddy (automatic HTTPS), waits for /readyz, and
# schedules daily verified backups. It never overwrites an existing .env.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/pranaykr43/IITI_HEALTH_CENTER.git}"
BRANCH="main"
APP_DIR="/opt/health-centre/app"
HOST=""
MODE="production"

usage() {
  cat <<'USAGE'
Usage: bash install.sh --host <public-dns-name> [--mode production|showcase] [--branch main] [--dir /opt/health-centre/app]

  production  Private deployment: staff must enrol in two-factor authentication; you create
              the first administrator interactively. No demo accounts.
  showcase    Public portfolio demo with synthetic data, published demo logins and a nightly
              reset. Uses NODE_ENV=demo. Never put real information in a showcase deployment.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$HOST" ]] || { usage; fail '--host is required (for example demo-health.duckdns.org)'; }
[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$HOST" == *.* ]] || fail "'$HOST' does not look like a DNS name"
[[ "$MODE" == production || "$MODE" == showcase ]] || fail '--mode must be production or showcase'
[[ "$(id -u)" -ne 0 ]] || fail 'Run as your normal sudo user, not root.'
command -v sudo >/dev/null || fail 'sudo is required'
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || fail "This installer supports Ubuntu; found ${ID:-unknown}"

mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if (( mem_kb < 2000000 )) && [[ -z "$(swapon --show --noheadings)" ]]; then
  log 'Adding 2 GB of swap (this machine has under 2 GB of RAM, e.g. the VM.Standard.E2.1.Micro shape)'
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

log "Checking that $HOST points at this machine"
public_ip="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
resolved_ip="$(getent ahostsv4 "$HOST" | awk 'NR==1 {print $1}' || true)"
if [[ -z "$resolved_ip" ]]; then
  fail "$HOST does not resolve yet. Create the DNS record (see docs/deploy-free.md) and try again."
elif [[ -n "$public_ip" && "$resolved_ip" != "$public_ip" ]]; then
  echo "Warning: $HOST resolves to $resolved_ip but this VM's public IP looks like $public_ip." >&2
  echo "HTTPS certificates will fail until DNS points here. Continuing in 10 seconds (Ctrl+C to stop)." >&2
  sleep 10
fi

log 'Installing Docker Engine and the Compose plugin'
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  sudo apt-get install -y git openssl curl >/dev/null
fi
sudo systemctl enable --now docker
DOCKER="sudo docker"

log 'Opening ports 80 and 443 in the VM firewall'
# Oracle's Ubuntu images ship iptables rules that reject everything except SSH, in addition
# to the cloud security list. Insert ACCEPT rules at the top and persist them.
for spec in "tcp 80" "tcp 443" "udp 443"; do
  set -- $spec
  if ! sudo iptables -C INPUT -p "$1" --dport "$2" -m state --state NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p "$1" --dport "$2" -m state --state NEW -j ACCEPT
  fi
done
if command -v netfilter-persistent >/dev/null; then
  sudo netfilter-persistent save >/dev/null
elif command -v ufw >/dev/null && sudo ufw status | grep -q 'Status: active'; then
  sudo ufw allow 80/tcp >/dev/null && sudo ufw allow 443 >/dev/null
fi

log "Fetching the application into $APP_DIR"
sudo mkdir -p "$(dirname "$APP_DIR")" /opt/health-centre/backups
sudo chown "$(id -un)":"$(id -gn)" "$(dirname "$APP_DIR")"
sudo chmod 700 /opt/health-centre/backups
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

log 'Writing the environment file'
if [[ -f .env ]]; then
  echo '.env already exists; leaving it unchanged.'
else
  umask 077
  mfa_key="$(openssl rand -base64 32)"
  metrics_token="$(openssl rand -hex 24)"
  {
    echo "# Generated by deploy/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file private (mode 600)."
    echo "PUBLIC_HOST=$HOST"
    echo "PUBLIC_BASE_URL=https://$HOST"
    echo "BACKUP_HOST_DIR=/opt/health-centre/backups"
    echo "BACKUP_RETENTION_DAYS=14"
    echo "CLINIC_TIMEZONE=Asia/Kolkata"
    echo "APPOINTMENT_SLOT_MINUTES=15"
    echo "LOG_LEVEL=info"
    echo "SESSION_TTL_SECONDS=28800"
    echo "# Back this key up separately from database backups; without it, 2FA enrolments cannot be decrypted."
    echo "MFA_ENCRYPTION_KEY=$mfa_key"
    echo "METRICS_TOKEN=$metrics_token"
    if [[ "$MODE" == showcase ]]; then
      demo_password="Demo-$(openssl rand -hex 6)!"
      echo "NODE_ENV=demo"
      echo "STAFF_MFA_REQUIRED=false"
      echo "HEALTH_DEMO_PASSWORD=$demo_password"
    else
      echo "NODE_ENV=production"
      echo "STAFF_MFA_REQUIRED=true"
    fi
    echo "# Optional: verified-domain email for password resets (both required together)."
    echo "RESEND_API_KEY="
    echo "EMAIL_FROM="
    echo "# Optional: patient Google sign-in (all three required together)."
    echo "GOOGLE_CLIENT_ID="
    echo "GOOGLE_CLIENT_SECRET="
    echo "GOOGLE_CALLBACK_URL=https://$HOST/auth/google/callback"
  } > .env
  chmod 600 .env
  unset mfa_key metrics_token
  umask 022
  echo '.env created with newly generated secrets (not printed).'
fi

log 'Building and starting the containers (first build takes a few minutes)'
$DOCKER compose build
$DOCKER compose up -d

log "Waiting for https://$HOST/readyz (certificate issuance can take a minute)"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "https://$HOST/readyz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 5
done
if [[ "$ready" -ne 1 ]]; then
  $DOCKER compose ps
  $DOCKER compose logs --tail=40 caddy web || true
  fail "The site did not become ready over HTTPS. Check the Oracle security list allows TCP 80/443 and that DNS points to this VM, then run: cd $APP_DIR && sudo docker compose up -d"
fi
echo "https://$HOST is up."

log 'Scheduling daily verified backups (02:17 UTC)'
if [[ ! -e /etc/cron.d/health-centre-backup ]]; then
  sudo bash scripts/install-backup-cron.sh "$APP_DIR"
else
  echo 'Backup schedule already present.'
fi
# The host-side backup script calls docker; let it run without an interactive sudo prompt.
sudo usermod -aG docker "$(id -un)"

if [[ "$MODE" == showcase ]]; then
  log 'Loading synthetic showcase data and scheduling a nightly reset (03:30 UTC)'
  $DOCKER compose exec -T web node scripts/seed-showcase.js >/dev/null
  if [[ ! -e /etc/cron.d/health-centre-showcase-reset ]]; then
    printf 'SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n30 3 * * * root cd "%s" && /bin/bash deploy/reset-showcase.sh >> /var/log/health-centre-showcase-reset.log 2>&1\n' "$APP_DIR" \
      | sudo tee /etc/cron.d/health-centre-showcase-reset >/dev/null
    sudo chmod 0644 /etc/cron.d/health-centre-showcase-reset
  fi
  demo_password_line="$(grep '^HEALTH_DEMO_PASSWORD=' .env | cut -d= -f2-)"
  cat <<DONE

Showcase is live at https://$HOST
Demo sign-ins (synthetic data, reset nightly; safe to publish in your README):
  Administrator  admin@health.local
  Doctor         doctor@health.local
  Patient        patient@health.local
  Password       $demo_password_line
DONE
else
  cat <<DONE

Production deployment is live at https://$HOST
Next steps:
  1. Create the first administrator (interactive, password never echoed):
       cd $APP_DIR && sudo docker compose run --rm web npm run admin:create
  2. Sign in at https://$HOST/login/admin and enrol in two-factor authentication.
  3. Back up the MFA_ENCRYPTION_KEY line from $APP_DIR/.env into your password manager.
  4. Later updates: bash $APP_DIR/deploy/update.sh
DONE
fi
