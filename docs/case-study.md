# Case study: from a fragile prototype to a verified appointment system

## The starting point

Health Centre began as a student prototype for booking campus clinic appointments. It worked in a demo, but:

- **Plaintext passwords and leaked secrets.** Passwords were compared in plaintext, and a Gmail app password was committed to the public repository.
- **No access control.** User identity came from URL parameters, so anyone could act as anyone.
- **Email before data.** A confirmation email went out *before* the appointment was saved, so a failed insert left a patient holding a confirmation for nothing.
- **Free-text states.** Appointment status was a free-text string such as `"not yet sheduled"`.
- **Double booking was possible.** Nothing prevented two patients being given the same doctor at the same time.
- **No tests at all.**

## What I changed, and why

| Problem | Decision | How it's verified |
|---|---|---|
| Duplicate and lost bookings on retry or crash | Idempotency keys per patient; appointment, audit row and notification event written in **one SQLite transaction** (transactional outbox) | Integration tests replay requests and simulate worker crashes |
| Double booking | Fixed-length slots aligned in the **clinic's time zone**, so a unique `(doctor, time)` index forbids overlaps at the database level | Concurrency test: two admins book the same slot at once and exactly one wins |
| Time-zone bug (10:30 IST booked as 16:00 IST on a UTC server) | Wall-clock input parsed in `CLINIC_TIMEZONE`; daylight-saving gaps rejected | Unit tests for IST, UTC and New York across a DST change |
| Notifications lost or sent twice | Worker with leases, claim-token fencing, capped exponential backoff, dead-lettering, audited redrive (max 3) | Fake-clock tests for stale workers, retries and recovery |
| Account takeover risks | bcrypt; hashed session tokens; failed-login throttling; constant-time comparisons; CSRF on every mutation; **TOTP two-factor authentication** with encrypted seeds, replay protection and hashed recovery codes | 25+ security tests, including RFC 6238 vectors and replayed-code rejection |
| Sensitive data spreading | Notification payloads carry IDs only (and a migration scrubbed old rows); expired sessions, tokens and old events purged hourly | Tests assert no symptom or phone text reaches the outbox |
| No visibility for staff | Scheduling desk with an open-slot picker, request trends and worker health; doctor agenda; read-only audit-log viewer | Browser tests across Chromium, Firefox and WebKit with axe accessibility checks |

## Deliberate non-choices

I kept Express, server-rendered EJS and SQLite. None of the real defects came from that stack, and replacing it would have discarded working tests. React, microservices, Kubernetes and PostgreSQL are documented in [`engineering-roadmap.md`](engineering-roadmap.md) along with the specific trigger that *would* justify each one, for example needing more than one web host.

## Design

The interface is built around one artefact from a campus clinic: the **appointment slip**. Each appointment is a perforated slip with a reference, a rubber-stamp status and a tear-off stub holding the date and time. Patients see their slips with a progress line; doctors see them as a day agenda; administrators schedule them from a queue. Ink-blue on prescription-paper tones, a dark mode, and full keyboard and screen-reader support complete it.

## Results

- **Tests:** 86 unit and integration tests, plus 39 browser runs (13 journeys × 3 engines), all passing in CI with a dependency audit and an ARM64 container smoke test.
- **Found and fixed during the audit:**
  - a credential leak;
  - an uninstallable dependency;
  - a time-zone scheduling bug;
  - overlapping bookings;
  - clinical data in notification payloads;
  - raw session tokens stored in the database;
  - several accessibility failures (contrast, label-in-name, invisible "screen-reader-only" text) that the axe checks caught.
- **Honest limits:**
  - It's a synthetic demonstration, not a certified medical-records system.
  - Two-factor codes aren't phishing-resistant (passkeys would be).
  - Rate limits are per process.
  - Notifications go to a console adapter rather than real email.

  [`industry-readiness-audit.md`](industry-readiness-audit.md) has the evidence for each claim.
