# Engineering log

## 2026-10-26

- Confirmed the application root is `Health_Centre-main` and the project is not inside a Git repository.
- Verified the checked-in project is an Express/Mongoose prototype with no runnable tests, no `public` directory, and no `views/error.ejs`.
- Confirmed `npm test` is the placeholder failure from `package.json`.
- Found the runtime entry points disagree: `index.js` starts an empty server on port 5000 while `bin/www` starts `app.js`.
- Found a 1,683-line mixed-responsibility router in `routes/login1.js` and repeated Mongo connections in every model module.
- Found hard-coded SMTP credentials in legacy mail paths and plaintext sample passwords in JSON exports. These are treated as remediation items, not copied into the rebuilt runtime.
- Chose a focused milestone: rebuild the appointment lifecycle around a single SQLite database, explicit state transitions, persistent sessions, idempotency, a transactional outbox, and a small accessible server-rendered interface.
- Deliberately did not add microservices, Kafka, Redis, Kubernetes, or AI; none addresses the current correctness failures.
- Replaced the active entry point with a modular Express + SQLite implementation and left the legacy router unmounted for reference.
- Added persistent sessions, bcrypt password hashing, CSRF checks, RBAC, validation, rate limiting, Helmet, request IDs, metrics, health/readiness, and configuration validation.
- Added explicit appointment transitions, actor-scoped idempotency, a partial unique doctor-slot index, audit rows, and a transactional outbox with a reclaimable claim lease.
- Added deterministic integration tests, a demo runner, a reproducible benchmark, CI, an operations runbook, and a rewritten README.
- Verified `npm ci`, `npm run check`, `npm audit --omit=dev`, `npm run demo`, `npm run benchmark`, `npm run seed`, and a live `/readyz` smoke check. Benchmark raw output is in `bench/results/latest.json`.

## 2026-11-09

- Created and pushed `backup/health-centre-pre-next-phase` at checkpoint commit `7b09781`; the existing `main` branch was not changed. The commit contains the active rebuilt app, its tests, docs, and CI. Local legacy exports, SQLite databases, dependencies, and modified legacy templates remain outside the commit.
- Verified the patient request → admin scheduling → doctor completion workflow in the browser using synthetic data and a separate `data/pilot-demo.sqlite` database. The doctor role was denied access to patient booking; an empty booking was rejected by required-field validation.
- Replaced a corrupted installed `superagent` parser through `npm ci`; dependencies then installed with 0 reported vulnerabilities.
- Added a concurrent doctor-slot scheduling test and strengthened outbox lease recovery coverage. `npm run check` passes across 4 test files.
- Added `npm run benchmark:http` for authenticated HTTP requests through Express using fresh temporary file-backed SQLite databases. Captured three 1,000-request runs; results and limitations are in `docs/benchmark-report.md`.
- Reran `npm run benchmark` with three 1,000-appointment runs. The prior ignored raw output was preserved locally before updating `bench/results/latest.json`.
- Added a dry-run-first legacy appointment JSON importer. It skips scheduled rows and unmatched or invalid patients, never reads legacy password files, and replays safely by source key. A local read-only dry run found 12 rows: 9 require manual review, 3 have no target patient, and 0 are eligible; no rows were imported.
- Added a separate notification worker with an injectable local console adapter, immediate SQLite claim transactions, lease tokens, stale-worker fencing, bounded exponential retries, and terminal `dead` handling.
- Added a versioned outbox migration, failure/recovery/concurrency tests, worker graceful shutdown, and operational guidance. `npm run lint`, `npm test`, `npm run check`, `npm run demo`, and `npm audit --omit=dev` pass; the audit reports 0 vulnerabilities.
- Re-reviewed the active application against the portfolio mission. Tightened production cookie parsing, removed the demo password fallback from production, disabled demo seeding in production, and made owned seed connections close on failure. Added tests and documented residual account-lifecycle, provider, observability, browser-automation, and deployment limits in `docs/current-engineering-review.md`.
- Added a Playwright Chromium suite for login/logout, protected routes, appointment creation/invalid input/cancellation, scheduling conflicts, doctor completion and ownership, CSRF/role boundaries, responsive viewports, keyboard access, and axe scans. Its launcher seeds only synthetic users into a fresh temporary SQLite database, binds a dynamically selected dedicated port, waits through `/readyz`, and cleans up without starting the notification worker. Added CI browser installation and artifact upload. Verification passed: `npm run lint`, `npm test` (6 files), `npm run check`, `npm run demo`, `npm audit --omit=dev` (0 vulnerabilities), and two consecutive `npm run test:e2e` runs (9 tests each).

## 2026-11-09 — Final project completion

- Added audited administrator provisioning for patient/doctor accounts and separately confirmed administrator accounts; disabling/reactivating revokes sessions, blocks inactive authentication, and protects the last active administrator.
- Added generic rate-limited password recovery with hashed single-use tokens, expiry, supersession, session revocation, query-string log redaction, and an unconfigured local adapter. No real email is sent, and production rejects injected recovery adapters until reviewed.
- Added administrator queue metrics/activity and CSRF-protected, audited, bounded redrive. Stable event identity and attempts are preserved with an at-least-once warning.
- Added online SQLite backup and staged restore commands with no-overwrite backup output, integrity/schema validation, explicit stopped-app confirmation, pre-restore safety copy, and rollback preservation. Automated backup/restore tests use synthetic temporary databases.
- Updated account/operations UI, patient visit summaries, responsive styles, role-specific README steps, operations and architecture docs, cross-browser CI, and refreshed service/HTTP benchmark measurements. Playwright now runs Chromium, Firefox, and WebKit against a synthetic DB on a dedicated loopback port; test-mode CSP avoids forcing the local HTTP harness to HTTPS while production retains HTTPS upgrade and HSTS headers.
- Verified `npm ci`, `npm run check` (8 test files), `npm run demo`, `npm audit --omit=dev` (0 vulnerabilities), and two consecutive full Playwright runs (33 tests each across Chromium, Firefox, and WebKit). The full install reports two high-severity development-tree audit findings; the production dependency audit remains clean.
- Reran the in-memory service benchmark and temporary-file-backed HTTP benchmark at 1,000 requests/appointments × 3 runs; captured measurements and limitations are in `docs/benchmark-report.md`. Previous ignored raw benchmark outputs were preserved locally.
- Kept the pre-existing legacy changes, deletions, JSON exports, and other local artifacts unstaged. The feature branch is isolated from `main`.
