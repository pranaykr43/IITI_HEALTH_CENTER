# Local operations runbook

## Start

```bash
npm ci
npm run seed
npm start
```

The default database is `data/health-centre.sqlite`. The database directory is intentionally ignored because it contains local state and session records.

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

The worker claims each event in a short `BEGIN IMMEDIATE` transaction, then invokes the adapter outside the transaction. Each claim receives a random fencing token and a lease. A worker may acknowledge or reschedule an event only while its token is current and its lease is unexpired. Expired claims are recoverable after a crash; stale workers cannot change a newer claim's result.

Transient adapter failures are retried with exponential backoff. Defaults are five attempts, a 1-second base delay, a 60-second cap, and a 30-second lease. After the final failed attempt, the event becomes `dead` and is not retried automatically. The event ID is stable across attempts; adapters that perform external side effects should use it as their idempotency key because delivery is at least once.

Tune the worker with `NOTIFICATION_POLL_INTERVAL_MS`, `NOTIFICATION_LEASE_MS`, `NOTIFICATION_MAX_ATTEMPTS`, `NOTIFICATION_RETRY_BASE_MS`, and `NOTIFICATION_RETRY_MAX_MS`. `Ctrl+C` or `SIGTERM` stops new passes, waits for the current adapter call to settle, then closes SQLite. If the process is killed before that, the lease expiry makes the event eligible for recovery. Back up the database before applying schema updates; startup runs the versioned outbox migration automatically.

Inspect the outbox from the administrator dashboard or directly in SQLite. `failed` means a retry is scheduled; `dead` means the configured attempt limit was reached and needs operator review.

## Backups

For a local demo, copy the SQLite database while the application is stopped. For a production deployment, use a database with a tested backup and restore process; this repository does not claim SQLite is sufficient for a multi-node clinical workload.

## Incident questions

1. Did `/readyz` fail, or only the external notification provider?
2. Is the appointment row present and in the expected state?
3. Is there a pending or failed outbox event for the appointment?
4. What request ID and audit record correspond to the state change?
5. Was the request retried with the same idempotency key?
