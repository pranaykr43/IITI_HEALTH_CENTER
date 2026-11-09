# Failure analysis and recovery contract

| Failure | Invariant | Recovery behavior | Guarantee |
|---|---|---|---|
| Client times out after booking | At most one appointment for an idempotency key | Retry with the same key returns the original row | Database + service |
| Same key, different payload | A key cannot represent two commands | Reject with conflict and do not mutate state | Service |
| Two admins schedule the same doctor/time | A confirmed slot is unique | One transaction commits; the other receives `409 Conflict` | Database unique index |
| Process crashes after appointment commit | Business state is durable and an event exists | Outbox worker resumes pending event after restart | Database + worker |
| Worker crashes after claiming an event | A claimed event must not be lost forever | The lease expires; a later pass atomically reclaims it with a new fencing token | At-least-once recovery |
| A stale worker finishes after a reclaim | Old work must not overwrite the current claim | Acknowledge/failure updates require the current token and a live lease | Database fencing |
| Notification adapter is unavailable | Appointment state must not roll back | Retryable failures use capped exponential backoff; exhausted events become `dead` | At-least-once attempts, bounded automatic retries |
| Invalid or oversized request | Domain tables contain only validated values | Return a stable `400`/`413`; no write | HTTP validation |
| Patient requests another patient's appointment | Ownership is enforced by authenticated user ID | Return `403`/`404` without revealing the row | HTTP + service |
| Replayed browser mutation | State transitions are monotonic and CSRF protected | Invalid transition is rejected; no duplicate side effect | Service + CSRF |
| Database becomes unavailable | Readiness must fail and errors must be observable | Return `503` for readiness and structured error logs | Operational behavior |

## What is not guaranteed

- SQLite serializes claims for workers sharing the same local database file; this does not provide a distributed lock across different databases or hosts.
- The default notification adapter only writes a local console summary. It does not claim delivery to a real email or SMS provider.
- A process can crash after an external provider accepts a notification but before SQLite records delivery. Such an event may be attempted again; real adapters need provider idempotency or deduplication by event ID.
- SQLite is not positioned as a high-write, multi-region production database.
- A user who has already authenticated can still lose their session when the configured session expires; there is no password reset or MFA flow in this milestone.
