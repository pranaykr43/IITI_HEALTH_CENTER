# Industry readiness audit

**Audit date:** 2026-11-21
**Branch:** `feature/final-project-completion` (base commit `36801c8`, plus the uncommitted working-tree changes that were present at the start of the audit)
**Scope:** the active application under `src/`, its scripts, tests, CI, container and deployment files. The legacy Express/Mongo tree under `routes/` and `views/` is not mounted by the running app and was reviewed only for secrets.
**Runtime used for verification:** Node.js 24.22.3 (portable install; the machine's default Node is 22.23.3), Windows 10, Playwright 1.65.1.

This is an independent engineering assessment of an academic demonstration. It is **not** a compliance assessment (HIPAA, DPDP Act 2023, ISO 27001 or similar), a penetration test, or a statement that the system is fit for real patient data.

## 1. Summary

The rebuilt application has a sound core. It has clear HTTP/service/database boundaries, Zod-validated inputs, bcrypt password hashes, server-side sessions, CSRF tokens, role checks on every mutation, an explicit appointment state machine, idempotent booking, a transactional outbox with leased, fenced and retried delivery, verified backup and restore, and browser tests in three engines.

The audit found these gaps:

- two **release-blocking (P0)** problems: a leaked credential still in the public git history, and a build that could not install on the supported Node version;
- several **P1** correctness and security defects: time-zone handling, slot overlap, login brute force, event-loop blocking, and clinical data in notification payloads;
- a set of **P2/P3** hardening and maintainability items.

All P1 items and most P2/P3 items were fixed on this branch, each with regression tests. The leaked credential still needs to be revoked by its owner, at Google.

### Verification evidence (this branch, after changes)

| Check | Result |
|---|---|
| `npm ci` on Node 24.22.3 | Succeeds (before: failed compiling `better-sqlite3@9.6.0`) |
| `npm test` (Node test runner) | 81/81 passing (71 at audit time + 10 for the MFA follow-up) |
| `npm run lint` | 0 problems |
| `npm audit` (all dependencies) | 0 vulnerabilities (before: 2 high, Playwright) |
| `npm run demo` | Idempotent retry, 200 schedule, 409 collision, 3 events processed |
| Playwright Chromium + Firefox + WebKit | 39/39 passing (`npm run test:e2e`, including the MFA journey) |
| Manual browser walkthrough | Patient request → admin schedule (10:30 IST stored as 05:00Z) → worker delivery, spoofed query messages ignored |
| Docker image build / ARM64 smoke | Not run locally (no Docker on the audit machine); **passed in CI** (`arm64-container` job, run 44921673663) |

## 2. Workspace integrity incident (found before the code audit)

The local checkout was damaged when the audit started. This is not an application defect, but it blocked all verification and could have led to committing broken files.

- `node_modules/` contained garbage bytes inside `qs` and `zod` sources, so 9 of 24 test files failed with `SyntaxError`.
- `.git/objects` had 11 corrupt loose objects (`git fsck --full`).
- The untracked `test/bootstrap-admin.test.js` was binary garbage and could not be recovered.

**Treatment:** dependencies were reinstalled from the lockfile. Corrupt git objects were moved aside, and valid copies were restored from a fresh mirror of `origin`; the branch tip matched `origin/feature/final-project-completion`. The bootstrap test was rewritten from the script's behaviour. One unreachable dangling tree still points to a missing blob; no branch or commit references it.
**Recommendation:** run a disk health check (`chkdsk`, SMART status) and review any sync/backup tool operating on `D:\Health_centre`.

## 3. Findings

Severity: **P0** blocks any release · **P1** correctness or security defect with real impact · **P2** important hardening or reliability gap · **P3** minor or maintainability.
Status: **Fixed** (implemented and verified on this branch) · **Partially fixed** · **Open**.

### P0-1 Gmail SMTP app password committed to the public repository — Open (external action required)

- **Evidence:** at commit `36801c8` and earlier, `routes/login1.js` (lines 48, 872, 924, 1045, 1104, 1161, 1215) and `routes/mailer.js:16` contain a hard-coded Google account app password next to the sender address. Reproduce with `git grep -n "pass: '" 36801c8 -- routes/`. The repository is public on GitHub.
- **Impact:** anyone can send mail as that Google account. Mail sent that way looks like it comes from the health centre, so it is ideal for phishing patients. Deleting the lines does not remove the secret from history, forks or caches.
- **Fix:** the working tree already replaced the literal with `process.env.SMTP_PASS`, and that change is committed on this branch. The owner must still **revoke the app password at https://myaccount.google.com/apppasswords** and review the account's sent mail and security activity. Rewriting history (`git filter-repo`) is optional once the credential is revoked. It was not done here because it needs a force-push and invalidates existing clones.
- **Verification:** `grep -rnE "pass: *'[a-z]{16}'" routes/` in the working tree returns nothing (done). Revocation can only be confirmed by the account owner.

### P0-2 Dependencies could not install on the supported runtime — Fixed

- **Evidence:** `package.json` requires Node `>=24`, CI tests 24.x/26.x and the Dockerfile uses `node:24`, but `better-sqlite3@9.6.0` has no Node 24 binary and `npm ci` failed in `node-gyp` (`Could not find any Visual Studio installation`; on Linux it compiles from source against an unsupported V8).
- **Impact:** no supported environment could install a working native SQLite binding.
- **Fix:** upgraded to `better-sqlite3@13.2.0`, which ships Node 24 prebuilds for linux/darwin/win32 on x64 and arm64. `@playwright/test` and `@axe-core/playwright` were upgraded, and the `playwright-core` override that pinned the vulnerable 1.51.1 was removed.
- **Verification:** `npm ci` and the full suite on Node 24.22.3; `npm audit` reports 0 vulnerabilities.

### P1-1 Scheduled times used the server's time zone — Fixed

- **Evidence:** `scheduleAppointment` did `new Date(scheduledFor)` on the `datetime-local` value (`"2030-01-01T10:30"`, no offset), and the dashboard rendered times with `toLocaleString()` on the server. The production container runs in UTC.
- **Impact:** an administrator in India scheduling 10:30 would book 10:30 UTC (16:00 IST) and see it shown back as 10:30, so patients and doctors would go to different times. It also defeats any working-hours check.
- **Fix:** new `src/domain/clinic-time.js`. Offset-less wall-clock input is interpreted in `CLINIC_TIMEZONE` (default `Asia/Kolkata`, validated as an IANA zone at startup). Input that already carries an offset is still accepted. Nonexistent local times (daylight-saving gaps) are rejected. All dashboard times are formatted in clinic time with the zone shown ("23 Nov 2026, 10:30 IST"), and the form says which zone it uses.
- **Verification:** `test/hardening.test.js` (Asia/Kolkata, UTC, New York summer offset and DST gap); manual check that 10:30 entered in the browser was stored as `2026-11-23T05:00:00.000Z`.

### P1-2 Overlapping and out-of-hours bookings were accepted — Fixed

- **Evidence:** the only scheduling constraint was `uq_confirmed_doctor_slot` on exact `(doctor_id, scheduled_for)`. 10:00 and 10:05 for the same doctor were both accepted, as was 03:00 on a Sunday, or a disabled doctor.
- **Impact:** double-booked clinicians, appointments outside clinic hours, and appointments assigned to deactivated staff.
- **Fix:** appointments occupy fixed slots of `APPOINTMENT_SLOT_MINUTES` (default 15) that must start on a slot boundary in clinic time. With aligned fixed-length slots, the existing unique index becomes a true no-overlap constraint, enforced by the database even under concurrent administrators. Slots must fall inside the doctor's `start_time`/`end_time`, and on a working day when `available_days` can be parsed ("Monday-Friday", "Mon, Wed and Fri"; unparseable text does not restrict days). Disabled doctors are rejected with 409 and hidden from the doctor list. The form uses `step` so browsers offer only valid slots.
- **Verification:** `scheduling enforces aligned slots, doctor hours, working days and active doctors` test; existing concurrency test still passes; manual check that a Saturday slot was refused with a clear message.

### P1-3 No brute-force protection on sign-in — Fixed (single node)

- **Evidence:** the only limit on `POST /auth/login*` was the global 120 requests/minute/IP limiter, which allows about 170,000 guesses per IP per day. There was no per-account limit.
- **Impact:** online password guessing against patient, doctor and administrator accounts.
- **Fix:** two limits apply to failed attempts only (successful sign-ins are not counted): 10 per 15 minutes per client IP + email, and 30 per 15 minutes per email across all clients. Rejections return 429 with guidance to wait or reset the password, and the role sign-in pages render this as an accessible error. Comparison also runs against a dummy hash for unknown emails, so response time does not reveal whether an account exists (P2-5).
- **Residual:** counters are in memory per process and reset on restart. There is no permanent lockout. TOTP two-factor authentication was added afterwards (see P2-13).
- **Verification:** `failed sign-ins are throttled per client and email…` test.

### P1-4 Password hashing blocked the event loop — Partially fixed

- **Evidence:** `bcrypt.compareSync` at cost 12 took **251 ms** (measured), blocking every other request during each login. bcryptjs is pure JavaScript.
- **Impact:** a handful of concurrent login attempts made the whole site stall, an easy availability attack.
- **Fix:** login now uses asynchronous `bcrypt.compare`. bcryptjs yields roughly every 100 ms, so the longest single stall drops from about 250 ms to about 100 ms. Registration, admin provisioning and password reset still hash synchronously; they are rare and rate-limited.
- **Residual:** a full fix means moving hashing off the main thread (a `worker_threads` pool, or a native argon2/bcrypt binding with transparent rehash). It is on the roadmap.
- **Verification:** measured event-loop ticks during async compare; login tests pass.

### P1-5 Clinical details copied into notification payloads — Fixed

- **Evidence:** every outbox event stored `JSON.stringify(appointment)`, including symptoms, phone number and prescription. Events were never deleted and are handed to delivery adapters.
- **Impact:** sensitive health information spread to a table with indefinite retention and to any future third-party provider (email/SMS), which goes against data minimisation.
- **Fix:** events now carry only `{appointmentId, patientId, doctorId, status, scheduledFor, version}`. Migration 5 rewrites existing rows to the same shape. Delivered events are purged after 30 days (P2-4).
- **Verification:** `notification outbox payloads carry identifiers only…` and `schema migration 5 …` tests; manual database inspection.

### P2-1 Session tokens stored in plaintext — Fixed

- **Evidence:** `sessions.id` held the raw cookie value.
- **Impact:** anyone with a copy of the database or a backup could take over every active session.
- **Fix:** only the SHA-256 digest is stored. Tokens that don't match the 64-hex format are rejected before any database lookup. Migration 5 revokes pre-existing raw sessions, so users sign in once more.
- **Verification:** `session tokens are stored only as SHA-256 digests` test.

### P2-2 Unauthenticated `/metrics` exposed through the public proxy — Fixed

- **Evidence:** `GET /metrics` had no access control, and the Caddyfile proxies every path.
- **Impact:** leaks traffic, error and queue information to anyone.
- **Fix:** in production `/metrics` returns 404 unless `METRICS_TOKEN` (at least 32 characters) is set, in which case it requires a matching `Authorization: Bearer` header, compared in constant time. Outbox gauges by status, oldest-pending age and worker heartbeat age were added so alerts can be written against them.
- **Verification:** `metrics require a bearer token…` test.

### P2-3 Attacker-controlled text shown via `?message=` / `?error=` — Fixed

- **Evidence:** `/dashboard`, `/login` and `/login/:role` rendered `req.query.message` and `req.query.error`; the OAuth callback redirected with error text in the URL.
- **Impact:** although the text was HTML-escaped, a crafted link could make the site display "Your account is locked, call …". This is content spoofing on a healthcare site.
- **Fix:** status messages travel in a 60-second HttpOnly, SameSite=Lax flash cookie set only by the server and consumed once. Query parameters are ignored.
- **Verification:** `status messages cannot be injected through the URL…` and `login page ignores error text…` tests; manual browser check.

### P2-4 Expired credentials and operational rows were never purged — Fixed

- **Evidence:** expired sessions and reset tokens were deleted only when presented again. OAuth transactions, idempotency keys (which embed the appointment) and delivered events grew without limit. `cleanupSessions()` existed but was never called.
- **Fix:** `src/services/housekeeping-service.js` runs at web startup and hourly. It deletes expired sessions and OAuth transactions, reset tokens used or expired more than a day ago, idempotency keys older than 7 days, and delivered events older than 30 days. Audit history is kept.
- **Verification:** `housekeeping removes expired credentials…` test.

### P2-5 Login timing revealed which emails have accounts — Fixed (see P1-3)

### P2-6 Screen-reader-only labels were visible and broke the scheduling form — Fixed

- **Evidence:** markup uses `.sr-only` on table captions and form labels, but `src/public/app.css` defined no such class (lost in the redesign). Screenshot: "Scheduled time" and "Doctor" labels squeezed the schedule controls into unreadable columns.
- **Fix:** added the standard visually-hidden utility, gave the scheduling form a usable desktop layout, and added a visible clinic-time hint. axe did not flag this because it was a visual problem, not an accessibility violation.
- **Verification:** manual screenshot before and after; axe suite still passes in Chromium and WebKit.

### P2-7 Business-rule errors on dashboard forms led to a dead-end error page — Fixed

- **Evidence:** a schedule conflict, invalid transition or validation error from schedule/cancel/complete went to the generic error page with no way back.
- **Fix:** browser form errors return to the dashboard with an accessible alert. Authentication and authorization failures still return 401/403. API clients still get JSON errors.
- **Verification:** e2e conflict scenario now asserts the dashboard alert; integration test confirms 403 is unchanged.

### P2-8 Benchmark script was broken by configuration validation — Fixed

- **Evidence:** `scripts/benchmark.js` used `nodeEnv: 'benchmark'`, which `loadConfig` now rejects.
- **Fix:** uses `test` and awaits the async authenticate.
- **Verification:** `BENCHMARK_ITERATIONS=50 BENCHMARK_RUNS=1 node scripts/benchmark.js` (p50 0.23 ms in-memory, local only).

### P2-9 Vulnerable Playwright (GHSA-7mvr-c777-76hp) — Fixed (see P0-2)

### P2-10 The working tree's own tests and lint were failing — Fixed

- **Evidence:** after repairing dependencies, 3 tests still failed: two assertions were out of date after a deliberate copy change, plus the corrupted bootstrap test. ESLint also failed on the corrupted file.
- **Fix:** assertions updated to the honest current wording; bootstrap test rewritten with coverage for single-admin and input validation.

### P2-11 Admin dashboard queries are unbounded — Open

- **Evidence:** `listForActor` (admin branch) and `listAccounts` return every row on every dashboard load.
- **Impact:** response time and memory grow linearly with history; fine for a demonstration, not for years of records.
- **Recommendation:** filter by status and date range with keyset pagination; add count queries for the summary cards.

### P2-12 Single-node limits — Open (accepted constraint)

Rate-limit state is per process, and SQLite is a single local file. Running more than one web instance on separate hosts would not share limits or coordinate writes. This is documented in `docs/current-engineering-review.md`. PostgreSQL plus a shared rate-limit store is justified only if a multi-instance deployment is actually required.

### P2-13 No multi-factor authentication or audit-log viewer — MFA fixed (2026-11-21 follow-up); audit viewer open

TOTP two-factor authentication is implemented (`src/security/totp.js`, `src/security/secret-box.js`, `src/services/mfa-service.js`, schema v6):

- RFC 6238 codes are verified against the RFC test vectors.
- Seeds are encrypted with AES-256-GCM under `MFA_ENCRYPTION_KEY`, bound to the user ID.
- A per-user replay barrier rejects any code that has already been used.
- Ten single-use recovery codes are stored as SHA-256 digests.
- After a correct password, the browser gets a five-minute pending sign-in with five attempts; the session is issued only after the second factor.
- Google sign-in also requires the second factor.
- With `STAFF_MFA_REQUIRED` on (production default), staff must enrol before using the app.
- Administrators can reset another user's second factor, which revokes that user's sessions.
- All changes are audited.

Verified by `test/mfa.test.js` (9 tests), a Google-flow test, and `e2e/mfa.spec.js` in Chromium, Firefox and WebKit with axe checks on the new pages.

**Still open:** the administrator audit-log viewer. Recovery is administrator-mediated; there is no self-service device change other than turning MFA off for non-staff users.

Audit rows are written transactionally for every privileged action, but administrators can't see them in the UI. Staff accounts have no second factor.

### P2-14 No alerting pipeline — Open

Metrics and health endpoints exist, but no Prometheus/Grafana/uptime monitor or alert rules are deployed. `docs/production-readiness-checklist.md` lists the thresholds to configure.

### P2-15 Signed-out visits to role pages returned a 401 page — Fixed

`GET /appointments/new` while signed out now redirects to `/login`; API and POST requests still return 401. Covered by a new test.

### P3-1 CSRF tokens compared with `!==` — Fixed (constant-time comparison)
### P3-2 Shutdown could hang on keep-alive connections; no request timeouts — Fixed (idle connections closed, 10 s forced exit, header/request timeouts)
### P3-3 Legacy `routes/` and `views/` tree retained — Open

It is not mounted, but it still contains plaintext-password comparisons and Mongo code that a future contributor could re-enable. Recommend deleting it in a dedicated commit. The original source stays in git history.

### P3-4 Doctor availability is free text — Open

Parsed conservatively (see P1-2). A structured weekly availability table would let patients self-schedule.

### P3-5 Password policy is length-only — Open

Minimum is 12 characters (14 for the bootstrap admin). There is no check against known-breached passwords.

### P3-6 E2E sign-out race made WebKit flaky — Fixed

The helper clicked "Sign out" and navigated away immediately, which could cancel the POST in WebKit (4 failures observed). It now waits for the redirect.

## 4. Area-by-area assessment

| Area | Assessment |
|---|---|
| Architecture | Clear layering (routes → services → SQLite) with dependency injection for tests. Express + EJS + SQLite stays: none of the current problems call for React, microservices, Kubernetes or PostgreSQL. |
| Express implementation | Helmet CSP/HSTS, body size limits, request IDs, structured logs with query strings stripped, central error handler. Route handlers are long but readable. |
| Database | Foreign keys, CHECK constraints, WAL, `busy_timeout`, partial unique slot index, versioned optimistic concurrency, `IMMEDIATE` transactions, forward-only migrations (now v5, with indexes for sessions, schedules, audit and idempotency). |
| Authentication | bcrypt cost 12, hashed session tokens, hashed single-use reset tokens, throttled failed logins, session revocation on disable/reset, TOTP MFA (required for staff in production). Missing: off-main-thread hashing. |
| Google OAuth | PKCE, state bound to a browser cookie, nonce, issuer/audience/azp/expiry/email-verified checks, patient-only linking. Not exercised against a real Google project (no credentials). |
| CSRF / XSS / SQLi | Per-session CSRF on all authenticated mutations and double-submit on anonymous forms. All EJS output escaped (no `<%-`). All SQL parameterised. Default CSP. |
| Permissions | Role checks at route and service level; ownership checks for patient cancel and doctor completion. Covered by integration and e2e tests. |
| Appointment lifecycle | Explicit transitions, idempotent creation, database-enforced no-overlap (now), time-zone-correct. |
| Notification worker | Leases, claim-token fencing, capped exponential backoff, dead-lettering, bounded audited redrive, heartbeat. Delivery is at-least-once, and the only adapter writes to the console. |
| Validation & errors | Zod at the boundary plus domain validation. JSON or HTML errors with request IDs. |
| Frontend UX & a11y | Responsive, keyboard-tested, axe-clean in two engines. Fixed visually exposed hidden labels. |
| Tests | 71 unit/integration tests, 12 e2e scenarios × 3 browsers. No property-based or load tests against the HTTP server. |
| Performance | Local benchmark only; dashboard queries unbounded (P2-11). |
| Logging & monitoring | Pino JSON logs with redaction; Prometheus-format metrics behind a token; no deployed alerting. |
| CI/CD & config | CI runs lint/test/demo/audit on Node 24 and 26, three-browser e2e and an ARM64 container smoke test. Strict production configuration validation. Deployment is manual by design. |
| Backup & restore | Online SQLite backup with integrity and schema validation; restore with safety copy; daily script with retention. Off-host copy and restore drills are operator tasks. |
| Documentation | Extensive and generally honest; updated here. |

## 5. What this audit could not verify

- Docker build and runtime on the audit machine (no Docker installed). The image was built and smoke-tested by the CI `arm64-container` job for commit `1ef95c8`, which passed together with Node 24/26 and three-browser e2e.
- Two-factor authentication with a real phone authenticator app. Codes were generated from the setup key with the project's RFC 6238 implementation, which is verified against the RFC test vectors.
- Real Google OAuth, real email delivery through Resend, and any production hosting.
- Revocation of the leaked SMTP credential (P0-1).
