# Operations runbook

## Check service health

`https://your-host/healthz` is a process liveness check. `/readyz` checks SQLite and returns 503 when the database cannot be queried. On the VM use `docker compose ps`, `docker compose logs --tail=100 web worker caddy`, and `docker compose exec web node -e "fetch('http://127.0.0.1:3000/readyz').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"`. Review logs privately; never paste full logs or database contents publicly.

## Worker

`docker compose ps worker` must report healthy. Its heartbeat is stored in the shared SQLite database. The worker polls the transactional outbox, claims events under leases, retries with bounded exponential delay, marks exhausted items terminal, and fences stale claims with tokens. On restart, expired leases become claimable. Appointment notification output uses a local console adapter. Password reset email, if enabled, is handled by the web process and Resend; this does not change appointment event delivery.

If worker health fails, inspect only the last few lines of worker logs, check volume free space, ensure web readiness is healthy, then `docker compose restart worker`. A worker restart is safe: unfinished claims recover after lease expiry. Do not edit SQLite rows manually. Use the admin redrive workflow with an audit reason for terminal events where appropriate.

## Disk and SQLite

Check `df -h`, `docker system df`, `du -sh` on the persistent health volume, and backup count/size. Do not remove Docker volumes, SQLite WAL/SHM sidecars, or the database file to reclaim space. Remove only expired timestamped backups through the retention process after verifying a recent off-VM copy. SQLite uses one web writer plus a worker sharing one local disk; do not mount the DB on NFS or start multiple independent VMs against the same SQLite file.

## Deploy updates

Take and validate a backup first. Fetch the intended approved feature branch/revision, inspect the release diff and dependency audit, build the image, then run `docker compose up -d web worker caddy`. Compose waits for web readiness before starting/restarting worker and Caddy. Watch `docker compose ps`, `/readyz`, worker heartbeat, and logs. Keep the prior source revision and backup available for rollback. Never delete `health_data` or use `docker compose down -v` during updates.

## Secrets and delivery

Keep `.env` readable only by the deployment operator. Rotate Resend, Google, and VM credentials at their provider after suspected exposure. If email is disabled, password reset requests produce a clear no-email message. If Resend is enabled, check provider status and sender verification; the UI still avoids confirming account existence. Do not treat console output as a sent email.

## Incidents

For suspected unauthorized access, disable public ingress at the firewall, preserve a private copy of logs and database for review, rotate exposed credentials, restore only from a known-good validated backup, and document actions without copying patient data. This is a synthetic demo; never use it as a clinical system.
