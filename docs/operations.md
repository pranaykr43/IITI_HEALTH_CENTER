# Local operations runbook

## Start

```bash
npm ci
npm run seed
npm start
```

The default database is `data/health-centre.sqlite`. The database directory is intentionally ignored because it contains local state and session records.

The checked-in seed accounts are for local development only. Demo seeding is rejected in production, and production startup requires secure cookies. Active administrators can provision patient/doctor accounts and separately confirm administrator creation. Disabling an account revokes its sessions and prevents session hydration or new authentication; the last active administrator cannot be disabled. All lifecycle changes are transactional and audited.

Password recovery responses do not disclose account existence. Reset tokens are stored only as SHA-256 hashes, expire after 30 minutes, are single-use, invalidate older outstanding tokens, and revoke active sessions. The default adapter logs only that local delivery is unconfigured; it never includes the reset URL or token. No real email is sent. The application rejects custom recovery adapters in production until provider delivery is reviewed. Configure `PUBLIC_BASE_URL` as the HTTPS origin before enabling an approved provider.

## Health checks

- `GET /healthz` confirms the process is responding.
- `GET /readyz` executes a database probe and returns `503` when the database cannot be used.
- `GET /metrics` exposes request, 5xx, appointment, and process uptime counters.

## Recovery

Run notifications as a separate process against the same SQLite file:

```bash
npm run worker:notifications
```

The default adapter writes a local console summary; it does not send email. A real provider can be injected through the notification adapter boundary when one is configured. Keep the worker supervised and point it at the same `HEALTH_DB_PATH` as the web process.

## Browser regression suite

Run `npm run test:e2e` to launch Chromium on a dynamically selected dedicated local HTTP port and against a fresh SQLite file created under the operating system temporary directory. The harness seeds synthetic patient, administrator, and doctor accounts (plus a second doctor for ownership checks), waits for `/readyz`, and removes its temporary database on shutdown. It does not read `HEALTH_DB_PATH`, change the development database, or start the notification worker. `npm run test:e2e:headed` runs visibly; `npm run test:e2e:report` opens the last HTML report. Playwright stores failure screenshots and traces under the ignored `test-results/` directory.

The worker claims each event in a short `BEGIN IMMEDIATE` transaction, then invokes the adapter outside the transaction. Each claim receives a random fencing token and a lease. A worker may acknowledge or reschedule an event only while its token is current and its lease is unexpired. Expired claims are recoverable after a crash; stale workers cannot change a newer claim's result.

Transient adapter failures are retried with exponential backoff. Defaults are five attempts, a 1-second base delay, a 60-second cap, and a 30-second lease. After the final failed attempt, the event becomes `dead` and is not retried automatically. The event ID is stable across attempts; adapters that perform external side effects should use it as their idempotency key because delivery is at least once.

Tune the worker with `NOTIFICATION_POLL_INTERVAL_MS`, `NOTIFICATION_LEASE_MS`, `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_RETRY_BASE_MS`, and `NOTIFICATION_RETRY_MAX_MS`. `Ctrl+C` or `SIGTERM` stops new passes, waits for the current adapter call to settle, then closes SQLite. If the process is killed before that, the lease expiry makes the event eligible for recovery. Back up the database before applying schema updates; startup runs the versioned outbox migration automatically.

Inspect counts, oldest pending age, cumulative attempts, heartbeat, and recent terminal delivery/failure history from the administrator dashboard. `failed` means a retry is scheduled; `dead` means the configured attempt limit was reached and needs operator review. Admins can redrive a dead event with a 10–500 character reason; the operation is CSRF-protected, audited, limited to three redrives per event, and preserves the stable event ID and prior attempts. At-least-once delivery means a provider may repeat an external effect after a crash.

## Backups

Create a verified online backup (safe with SQLite WAL enabled):

```bash
npm run db:backup -- ./private-backups/health-centre-2026-11-09.sqlite
```

The destination must not already exist. The command uses SQLite's online backup API, then checks integrity, required schema version, and expected tables. Store backups outside the repository and restrict access.

To restore, stop both the web process and notification worker, then explicitly declare that state:

```bash
npm run db:restore -- ./private-backups/health-centre-2026-11-09.sqlite --confirm-stopped
```

Restore verifies source integrity/schema, stages a same-volume copy, validates it, writes a non-overwriting `.pre-restore-*` online safety backup of the current DB, then atomically replaces the configured target. It also retains the displaced original as a rollback file. Restore tests use only synthetic temporary databases. This runbook does not establish SQLite as sufficient for a multi-node clinical workload.

## Incident questions

1. Did `/readyz` fail, or only the external notification provider?
2. Is the appointment row present and in the expected state?
3. Is there a pending or failed outbox event for the appointment?
4. What request ID and audit record correspond to the state change?
5. Was the request retried with the same idempotency key?
