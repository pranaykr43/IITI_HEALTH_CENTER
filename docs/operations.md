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

Stop the process cleanly with `Ctrl+C`; the server closes its HTTP listener and SQLite handle. A pending outbox event is durable and can be drained by the service on the next worker run. The current local worker is intentionally manual (`processOutboxOnce`) for deterministic tests; a future deployment should run it in a supervised worker process.

## Backups

For a local demo, copy the SQLite database while the application is stopped. For a production deployment, use a database with a tested backup and restore process; this repository does not claim SQLite is sufficient for a multi-node clinical workload.

## Incident questions

1. Did `/readyz` fail, or only the external notification provider?
2. Is the appointment row present and in the expected state?
3. Is there a pending or failed outbox event for the appointment?
4. What request ID and audit record correspond to the state change?
5. Was the request retried with the same idempotency key?
