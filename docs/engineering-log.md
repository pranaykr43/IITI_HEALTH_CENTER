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
