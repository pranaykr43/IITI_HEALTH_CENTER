# Production backup and restore

## Backup schedule

Create the host backup directory and install the repository's cron entry from the VM checkout:

```sh
sudo mkdir -p /opt/health-centre/backups
sudo chown 1000:1000 /opt/health-centre/backups
sudo bash scripts/install-backup-cron.sh /opt/health-centre
```

At 02:17 server time each day, the job runs `scripts/run-host-backup.sh` as the deployment user from `sudo`'s `SUDO_USER`. Ensure that account can run Docker Compose and has OCI CLI credentials when using off-VM uploads. Compose bind-mounts the host backup directory into the container at `/var/lib/health/backups`; the image's `node` user is UID 1000. The script creates a timestamped SQLite online backup, runs `PRAGMA integrity_check`, verifies required schema tables and schema version 4, and removes backups older than 14 days. Set `BACKUP_RETENTION_DAYS` to a positive integer if needed. Logs contain only the backup path/schema and retention outcome; protect logs and backups as sensitive data even for a demo.

The schedule stores backups on the VM and does not cover VM loss. For resilience, create a home-region Always Free Object Storage bucket and install/configure OCI CLI on the host. Add a non-secret `OCI_BACKUP_BUCKET=your-bucket-name` variable to `/etc/cron.d/health-centre-backup` above the scheduled command to enable upload in `run-host-backup.sh`. Restrict IAM to the target bucket, enable lifecycle deletion, and monitor the documented 20 GB / 50,000-request Always Free limits. Do not upload to a paid resource. Confirm upload success without printing credentials. Without the bucket setting, the script prints that it made only a local copy.

## Restore drill

Perform a drill before go-live and after changing backup tooling. Use a disposable copy of the database and never overwrite production during the drill:

1. Create a test database using the normal app migrations and synthetic accounts/appointments.
2. Run `npm run db:backup -- <new-backup-file>` and retain the success output.
3. Copy that backup to a **different disposable database path**, stop the app/worker using that path, and verify it with `npm run db:backup` validation or `scripts/database-backup.js`'s `validateDatabase`.
4. Restore into a disposable existing target with `docker compose run --rm --no-deps web npm run db:restore -- /var/lib/health/backups/<backup-file> --confirm-stopped`. Stop the web and worker first. Confirm the script makes a pre-restore safety backup and validates the restored schema.
5. Start the disposable app and confirm `/readyz`, login, appointment listing, and outbox state. Record date, backup filename, schema version, and pass/fail without account values or appointment content.
6. Remove only the drill copies after the exercise; keep the real backup set untouched.

For an actual restore, stop **both** `web` and `worker`, retain a copy of the current volume, run the same one-off `docker compose run --rm --no-deps web ...` command with the intended backup filename, then restart and validate. A deployment checkout or restore source must never be the only copy.

## Recovery scenarios

- **Container restart/update:** `docker compose pull` for Caddy if desired, `docker compose build web`, `docker compose up -d web worker caddy`; named volumes keep SQLite and Caddy state.
- **SQLite corruption:** stop web and worker; preserve a copy of the corrupt volume; select the newest integrity-verified off-VM backup; restore with the stopped-app confirmation; start services and check `/readyz` and synthetic workflows.
- **VM loss/reclamation:** provision a new Always Free eligible VM if capacity exists, reinstall Docker, restore the Compose checkout and protected `.env`, restore the latest off-VM backup into a persistent volume, validate before public DNS cutover. A local-only backup is lost with the VM.
- **Backup upload/retention failure:** fix bucket credentials/quota, preserve existing valid backups, rerun manually, verify object existence and validation. Do not log OCI secrets.
- **Bad release:** stop new containers, keep a pre-update database backup, rebuild/pin the previous known image revision, restore only if migration compatibility requires it; test the restore path first.
