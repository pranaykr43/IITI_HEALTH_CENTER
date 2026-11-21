# Engineering roadmap

**Updated:** 2026-11-21. Finding IDs refer to `docs/industry-readiness-audit.md`.

Guiding constraints: keep the server-rendered Express + EJS + SQLite architecture, preserve existing workflows, and add technology only when a current invariant or requirement needs it. PostgreSQL, a SPA framework, microservices and Kubernetes are **not** on this roadmap. The trigger that would justify revisiting each is noted where relevant.

## Part A — Defects (things that are wrong today)

| Priority | Item | Status |
|---|---|---|
| P0 | Revoke the leaked Gmail app password (P0-1); optionally purge it from history with `git filter-repo` and a coordinated force-push | **Owner action required** |
| P0 | Native SQLite binding did not install on Node 24 (P0-2) | Done |
| P1 | Scheduling used the server time zone (P1-1) | Done |
| P1 | Overlapping, out-of-hours and disabled-doctor bookings (P1-2) | Done |
| P1 | Sign-in brute force (P1-3) | Done (single node) |
| P1 | Clinical data in notification payloads (P1-5) | Done, including migration |
| P1 | Event-loop blocking by bcrypt (P1-4) | Partly done; finish in Phase 1 below |
| P2 | Plaintext session tokens, public metrics, URL message spoofing, missing purge, login timing, hidden-label CSS, dead-end form errors, broken benchmark, failing tests (P2-1…P2-10) | Done |
| P2 | Unbounded admin dashboard queries (P2-11) | Phase 2 |
| P3 | Non-constant-time CSRF comparison, shutdown hang, WebKit test race, signed-out redirect (P3-1, P3-2, P3-6, P2-15) | Done |

## Part B — Improvements, in priority order

### Phase 1 — Security (next)

1. **Staff MFA (TOTP).** Enrolment with recovery codes, required for doctors and administrators, audited. *Verify:* integration tests for enrolment, login with/without code, recovery-code single use; e2e sign-in.
2. **Off-main-thread password hashing.** A small `worker_threads` pool running bcrypt, or argon2id via a maintained native module with rehash on successful login. *Verify:* event-loop delay histogram under 20 concurrent logins stays below 20 ms.
3. **Breached-password screening** at registration, reset and admin provisioning. *Verify:* unit test with a fixture list; no plaintext leaves the process.
4. **Delete the legacy `routes/` and `views/` tree** and the Express-generator `bin/www` shim. *Verify:* the app still boots and all tests pass.

### Phase 2 — Data integrity and maintainability

1. **Structured doctor availability**: a `doctor_availability(doctor_id, weekday, start_minute, end_minute)` table replacing free text, edited by administrators. *Verify:* migration converts parseable text; scheduling tests cover multiple windows per day.
2. **Bounded dashboard queries**: status/date filters and keyset pagination for appointments and accounts; summary counts via aggregate queries. *Verify:* query plan uses `idx_appointments_scheduled` / `idx_appointments_status`; test with 10,000 synthetic rows.
3. **Split `routes.js` by role** (auth, patient, admin, doctor routers) without behaviour change. *Verify:* full suite passes unchanged.
4. **Reschedule workflow** (confirmed → confirmed with a new slot) as an explicit audited transition. *Verify:* state-machine and collision tests.

### Phase 3 — User experience and accessibility

1. **Administrator audit-log viewer** (read-only, filtered, paginated).
2. **Patient self-scheduling** from published availability (depends on Phase 2.1).
3. **Assistive-technology testing** with NVDA and VoiceOver on the three role dashboards; record findings.
4. **Localised date input** showing the clinic zone label next to every time field (partly done).

### Phase 4 — Testing and reliability

1. HTTP-level load test (autocannon or k6) of login, booking and dashboard on the target VM; record p95/p99 and event-loop delay.
2. Property-based tests for the appointment state machine and slot parser.
3. Worker lease extension (heartbeat while delivering) if a real provider can exceed the lease.
4. Restore drill automated in CI against a synthetic database.

### Phase 5 — Operations

1. Deploy Prometheus (or an uptime service) scraping `/metrics` with the token; alert rules from `docs/production-readiness-checklist.md`.
2. Encrypted off-host backup copies with a retention policy and a documented quarterly restore drill.
3. Error reporting with PII scrubbing (self-hosted or a provider under a data-processing agreement).
4. Real email provider for appointment notifications, deduplicated by `eventId`, sending no clinical details.

### When to revisit the architecture

| Trigger | Change it would justify |
|---|---|
| More than one web host is required for availability | PostgreSQL (or LiteFS-style replication) plus a shared rate-limit store |
| Sustained write contention visible in `busy_timeout` errors or p99 latency | Same as above, after measuring |
| Rich client interactivity that server rendering cannot provide (for example a live scheduling board) | Progressive enhancement first; a client framework only for that surface |
| Independent teams owning separate deployable domains | Service boundaries; not before |
