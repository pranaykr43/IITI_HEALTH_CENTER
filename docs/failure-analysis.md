# Failure analysis and recovery contract

| Failure | Invariant | Recovery behavior | Guarantee |
|---|---|---|---|
| Client times out after booking | At most one appointment for an idempotency key | Retry with the same key returns the original row | Database + service |
| Same key, different payload | A key cannot represent two commands | Reject with conflict and do not mutate state | Service |
| Two admins schedule the same doctor/time | A confirmed slot is unique | One transaction commits; the other receives `409 Conflict` | Database unique index |
| Process crashes after appointment commit | Business state is durable and an event exists | Outbox worker resumes pending event after restart | Database + worker |
| Worker crashes after claiming an event | A claimed event must not be lost forever | The 30-second claim lease expires and a later worker pass can reclaim it | Best-effort worker recovery |
| Notification provider is unavailable | Appointment state must not roll back | Event remains pending/failed with attempts for retry | Best effort for external side effect |
| Invalid or oversized request | Domain tables contain only validated values | Return a stable `400`/`413`; no write | HTTP validation |
| Patient requests another patient's appointment | Ownership is enforced by authenticated user ID | Return `403`/`404` without revealing the row | HTTP + service |
| Replayed browser mutation | State transitions are monotonic and CSRF protected | Invalid transition is rejected; no duplicate side effect | Service + CSRF |
| Database becomes unavailable | Readiness must fail and errors must be observable | Return `503` for readiness and structured error logs | Operational behavior |

## What is not guaranteed

- The local demo does not provide multi-process worker coordination or a distributed lock service.
- The notification worker is intentionally a local adapter; it does not claim delivery to a real SMTP provider.
- SQLite is not positioned as a high-write, multi-region production database.
- A user who has already authenticated can still lose their session when the configured session expires; there is no password reset or MFA flow in this milestone.
