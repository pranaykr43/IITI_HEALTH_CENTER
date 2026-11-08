# Engineering audit

## Executive verdict

This repository is a student prototype, not a deployable health-centre system. Its strongest idea is the appointment workflow, but the implementation currently combines a copied template-heavy UI with an unbounded Express router, direct database calls, plaintext credentials, and no meaningful automated checks. The project cannot honestly claim the reliability, security, or MongoDB architecture described in its README.

The rebuild deliberately narrows the production-grade surface to the highest-value workflow: authenticate a patient, create an appointment safely, allow an administrator to schedule it exactly once, and let the assigned doctor complete it. The legacy templates and routes remain in the repository for reference but are no longer mounted by the application entry point.

## Prioritized findings

### P0 — The application is not reproducibly runnable

- **Evidence:** `package.json` has no `cors` or `nodemailer` dependency even though `routes/login1.js` requires both. `views/error.ejs` is referenced by `app.js` but is absent. `npm test` is a placeholder that exits 1. `index.js` starts a separate empty Express server on port 5000 while `bin/www` starts `app.js` on port 3000.
- **Failure scenario:** A clean checkout cannot install and start the documented application reliably. Even after installing the declared dependencies, the first request that reaches the error handler can fail again because the error view does not exist.
- **Severity:** Critical. There is no trustworthy baseline for any feature, security, or performance claim.
- **Correct solution:** One entry point, explicit environment validation, a real test command, one database lifecycle, and a smoke-testable local demo. The rebuilt app provides these through `src/server.js`, `npm test`, and an in-memory demo mode.

### P0 — Credentials and passwords cross trust boundaries unsafely

- **Evidence:** `routes/login1.js` and `routes/mailer.js` contain a hard-coded SMTP app credential. The JSON exports contain plaintext passwords. Login compares `check.password === req.body.password`; no session or authorization middleware exists.
- **Failure scenario:** Anyone with repository access can send mail as the configured account. A database export leak immediately becomes account takeover. Any user who knows an appointment ID can reach mutation URLs because identity is encoded in path parameters rather than established server-side.
- **Severity:** Critical. This is credential compromise and broken access control, not a cosmetic issue.
- **Correct solution:** Remove repository secrets, hash passwords, establish a server-side session, enforce role checks at the route boundary, add CSRF protection to browser mutations, and never trust user identity from URL parameters.

### P0 — Appointment state is not protected by a database invariant

- **Evidence:** `routes/login1.js:817-827` updates an appointment with the entire `req.body`; scheduling is represented by free-form strings such as `"not yet sheduled"`, and there is no unique constraint for a doctor/time slot or atomic state transition.
- **Failure scenario:** Two administrators submit the same appointment or two patients are scheduled for the same doctor and time. Both requests can succeed, or a malicious form can overwrite prescription fields and status fields at once.
- **Severity:** Critical. Double-booking and unauthorized mutation are correctness failures with real operational consequences.
- **Correct solution:** Use an explicit state machine, allow-list update fields, perform conditional updates with a version, and enforce a partial unique index on confirmed doctor/time slots inside a transaction.

### P1 — The router is an untestable god module

- **Evidence:** `routes/login1.js` is 1,683 lines and mixes rendering, validation, persistence, email, authorization, and error handling. The same appointment and email logic is duplicated three times. Each model file opens its own Mongo connection.
- **Failure scenario:** A change to login, mail, or appointment scheduling changes unrelated behavior; a callback error can be swallowed after a response has already started. No isolated unit can prove the invariant without booting the whole process and a live MongoDB instance.
- **Severity:** High. Change risk and recovery cost grow faster than the feature set.
- **Correct solution:** Separate HTTP adapters, domain rules, persistence, and side effects. The rebuild uses a single database adapter, a service boundary, and a transactional outbox.

### P1 — Side effects happen before durable state

- **Evidence:** Booking sends email before `collection.insertMany` (`routes/login1.js:1041-1066`); prescription and doctor creation follow the same pattern. There is no retry policy, outbox, or delivery state.
- **Failure scenario:** SMTP succeeds and Mongo insert fails, so the patient receives a confirmation for an appointment that does not exist. A client timeout causes a retry and sends duplicate emails and creates duplicate appointments.
- **Severity:** High. The system can report contradictory facts to users.
- **Correct solution:** Commit the business state and an outbox event atomically. A worker may deliver notifications at least once; the business operation is idempotent and the delivery guarantee is stated honestly.

### P1 — Error handling is inconsistent and leaks implementation details

- **Evidence:** The code mixes callbacks and `async` functions, returns `400` for infrastructure failures, uses `res.send("error")`, logs raw errors, and sometimes continues after a failed query. `res.locals.error` exposes the full error object in development.
- **Failure scenario:** A database outage is presented as a client validation error, while a production misconfiguration becomes a stack trace or a blank page. Operators have no request correlation or structured event to investigate.
- **Severity:** High. Diagnosis and client behavior become unreliable precisely when the system is unhealthy.
- **Correct solution:** Classify errors, return stable JSON/HTML errors, attach request IDs, log structured events, and expose health/readiness endpoints.

### P1 — Data modeling is stringly typed and permits corrupt history

- **Evidence:** Dates, times, age, status, doctor assignment, and prescription fields are all free-form strings in `routes/appointment.js`. Historical records are stored in a separate model with a duplicated schema and are never written by the shown appointment flow.
- **Failure scenario:** Invalid dates such as those already present in `appointmentsdatabase.json` sort incorrectly; missing fields from old documents render as undefined; typo variants of the same status become different states.
- **Severity:** High. Reports, scheduling, and patient history cannot be trusted.
- **Correct solution:** Store ISO timestamps, integer ages, constrained status values, foreign keys, explicit nullable fields, and indexes. The rebuild treats the appointment row as the source of truth instead of copying it into a second collection.

### P2 — Destructive operations and identity checks are unsafe

- **Evidence:** Several deletes are GET routes (`routes/login1.js:757-813`), patient history searches by email and phone supplied by the requester (`routes/login1.js:1403-1503`), and `findByIdAndUpdate` accepts all request fields.
- **Failure scenario:** A crawler, prefetcher, or malicious link can delete records. Any person who knows another patient's email and phone can enumerate their history. A crafted form can alter fields the UI never displays.
- **Severity:** High.
- **Correct solution:** Use POST/DELETE with CSRF protection, server-side ownership checks, explicit field schemas, and authenticated resource queries.

### P2 — Global mutable variables create cross-request contamination

- **Evidence:** `rate1` through `rate5` are assigned without declarations in `routes/login1.js:219-230` and repeated elsewhere.
- **Failure scenario:** Two concurrent dashboard requests overwrite shared values. A failed query can leave stale counts visible in another response.
- **Severity:** Medium-high.
- **Correct solution:** Keep request data local and query aggregates as one deterministic statement.

### P2 — The UI is a copied, brittle shell rather than an operational interface

- **Evidence:** `views/homemain.ejs` is 13,302 lines and contains a large inline Bootstrap copy, absolute pixel positioning, external assets without a local fallback, and repeated markup. `studentdashboard.ejs` is 14,149 lines with duplicated CSS and layout coordinates such as `margin-left: 1050px`.
- **Failure scenario:** A small viewport, missing CDN, keyboard navigation, or a slow network produces an unusable page. The dashboard numbers are not tied to an authenticated user's scope.
- **Severity:** Medium. It damages usability and makes the system look more complete than it is.
- **Correct solution:** Replace the active surface with a small responsive server-rendered UI that exposes real state, loading/error/empty states, and accessible controls. Keep the legacy templates out of the runtime path.

### P2 — Documentation claims exceed the checked-in implementation

- **Evidence:** `Readme.md` describes a MongoDB backend with 11 collections, email automation, and a `login1.js` workflow, but no migration, seed command, tests, or reproducible environment is present. `instructions.txt` contains no instructions.
- **Failure scenario:** A new engineer follows the README, starts the wrong file, and cannot determine which database or credentials are required.
- **Severity:** Medium.
- **Correct solution:** Document the real architecture, exact commands, guarantees, limitations, and measured results. The new README and design docs are written from the implementation rather than from aspirational claims.

## What is worth preserving

- The domain problem is concrete and useful: appointment intake, administrative scheduling, and clinical follow-up.
- The existing views demonstrate the intended user roles and the original workflow vocabulary.
- The exported sample data is useful as historical input for a future migration tool, but it is not safe or valid production data.

## Explicit non-goals for this milestone

The rebuild does not introduce microservices, Kafka, Redis, Kubernetes, a SPA rewrite, or an AI feature. None is justified by the current scale or the actual failure modes. The high-value engineering signal is correctness under retries and concurrent scheduling, not infrastructure theater.
