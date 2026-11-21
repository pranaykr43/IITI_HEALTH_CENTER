# Security review

**Date:** 2026-11-21 · **Branch:** `feature/final-project-completion`
**Method:** manual review of the source code and configuration, targeted regression tests, and manual browser checks. No automated DAST scan or third-party penetration test was performed.
**Data classification:** the application is designed to hold health information (symptoms, prescriptions) and personal identifiers (name, email, phone, age). Treat any real deployment as handling sensitive personal data. The project is operated only as a synthetic demonstration (`DEMO_MODE=true` is required in production).

## Threat model (summary)

| Asset | Threat | Primary controls |
|---|---|---|
| Patient health details | Unauthorised reading by other patients, staff without need, or a copied database | Server-side RBAC and ownership checks; minimised notification payloads; hashed session tokens; backups stored owner-only (`umask 077`) |
| Staff accounts | Password guessing, phishing, session theft | bcrypt cost 12; failed-login throttling; HttpOnly/SameSite/Secure cookies; no free-text URL messages; session revocation on disable/reset |
| Appointment integrity | Double booking, forged state changes, replayed requests | Database no-overlap constraint on aligned slots; CSRF tokens; explicit state machine with versioned updates; idempotency keys |
| Availability | Login floods, large bodies, slow clients | Global and login rate limits; 32 kB body limit; async password comparison; header/request timeouts |
| Outbound notifications | Duplicate or misdirected messages, data leakage to a provider | At-least-once delivery with stable event IDs; identifier-only payloads; console adapter by default |

## Controls verified in code

| Control | Location | Evidence |
|---|---|---|
| Password hashing (bcrypt, cost 12) | `src/services/auth-service.js` | Tests assert hashes never equal plaintext |
| Equal-time handling of unknown emails | `authenticate()` compares against a dummy hash | Code review |
| Session tokens: 256-bit random, stored as SHA-256 | `createSession` / `getSession` | `test/hardening.test.js` |
| Cookie flags | `health_session`: HttpOnly, SameSite=Lax, Secure in production (startup fails otherwise) | `test/config.test.js` |
| CSRF | Per-session token on authenticated mutations; double-submit cookie on anonymous forms; constant-time comparison | Integration and e2e CSRF tests |
| RBAC and ownership | `requireRole` at routes plus re-checks inside services | `ownership and role boundaries…` tests, e2e authorization spec |
| Failed-login throttling | `loginClientLimiter`, `loginAccountLimiter` in `src/http/routes.js` | Hardening test |
| Two-factor authentication | RFC 6238 TOTP; AES-256-GCM-encrypted seeds bound to the user; replay barrier; hashed single-use recovery codes; pending sign-in with 5 attempts and 5-minute expiry; staff enrolment enforced; admin reset revokes sessions; audited | `test/mfa.test.js`, `e2e/mfa.spec.js` |
| Password reset | 256-bit tokens stored hashed, 30-minute expiry, single use, older tokens superseded, sessions revoked, generic response with a fixed minimum delay, delivery decoupled from response timing, rate limited | `test/password-reset.test.js`, integration test |
| Google OAuth | PKCE S256, state bound to a browser cookie, nonce, `iss`/`aud`/`azp`/`exp`/`email_verified` checks, patient-only linking, subject pinning | `test/authentication-ux.test.js` (mocked provider) |
| Output encoding | All EJS data output uses `<%= %>`; `<%-` appears only for `include()` of partials; slot data reaches the browser in an escaped `data-` attribute, not a script block | `grep "<%-" src/views | grep -v include` returns nothing |
| SQL injection | Parameterised `better-sqlite3` statements only; the one dynamic SQL fragment (migration column names) is built from a fixed allowlist | Code review |
| Security headers | Helmet defaults (CSP `default-src 'self'`, `frame-ancestors 'self'`, nosniff, Referrer-Policy no-referrer), HSTS and `upgrade-insecure-requests` in production | Integration test |
| Log hygiene | Query strings stripped from request logs; authorization, cookie, CSRF, password, token and reset-URL fields redacted | `src/http/app.js` |
| Metrics access | Production: 404 without `METRICS_TOKEN`; bearer token compared in constant time | Hardening test |
| Data minimisation in events | Identifier-only outbox payloads; migration scrubs older rows | Hardening tests |
| Retention | Expired credentials purged hourly; delivered events after 30 days; idempotency replays after 7 days | Hardening test |
| Configuration safety | Production refuses insecure cookies, non-HTTPS base URL, relative/in-memory DB path, demo seeding, unknown `NODE_ENV`, invalid proxy hops, partial OAuth/email configuration, invalid time zone | `test/config.test.js`, hardening test |
| Container | Non-root `node` user, production-only dependencies, `.dockerignore` excludes env files, databases and legacy data | `Dockerfile`, `.dockerignore` (not built locally) |

## Findings

Full evidence and reproduction steps are in `docs/industry-readiness-audit.md`.

| ID | Severity | Issue | Status |
|---|---|---|---|
| P0-1 | P0 | Gmail SMTP app password committed in public git history (`routes/login1.js`, `routes/mailer.js` at `36801c8`) | **Open — owner must revoke the credential at Google.** Removed from the working tree. History not rewritten. |
| P1-3 | P1 | No brute-force protection on sign-in | Fixed (per-process limits) |
| P1-4 | P1 | Synchronous bcrypt blocked the event loop (251 ms per check) | Partially fixed (async; stalls ≤ ~100 ms) |
| P1-5 | P1 | Symptoms, phone and prescriptions copied into retained outbox payloads | Fixed, including migration of existing rows |
| P2-1 | P2 | Raw session tokens in the database and backups | Fixed |
| P2-2 | P2 | Public, unauthenticated `/metrics` | Fixed |
| P2-3 | P2 | Content spoofing through `?message=` / `?error=` | Fixed |
| P2-4 | P2 | No purge of expired credentials | Fixed |
| P2-5 | P2 | Login timing revealed which emails have accounts | Fixed |
| P2-9 | P2 | Playwright advisory GHSA-7mvr-c777-76hp (dev dependency) | Fixed |
| P2-13 | P2 | No MFA for staff; no audit viewer | MFA fixed (TOTP, required for staff in production); audit viewer open |
| P3-1 | P3 | Non-constant-time CSRF comparison | Fixed |
| P3-3 | P3 | Legacy unmounted code with plaintext-password logic | Open (recommend deletion) |
| P3-5 | P3 | Length-only password policy | Open |

## Residual risks and assumptions

1. **Leaked credential (P0-1).** Until revoked, anyone can send email as the project's Gmail account.
2. **Single-process rate limits.** Restarting the process resets counters, and several instances would each have their own budget.
3. **Second factor is TOTP, not phishing-resistant.** A real-time phishing proxy can relay a code. WebAuthn/passkeys would close this. `MFA_ENCRYPTION_KEY` must be protected and backed up separately from the database; whoever holds both the key and a database copy can derive users' codes.
4. **Email-based Google linking.** A verified Google email links to an existing patient account with the same email. This is safe only while email ownership is verified by Google (enforced) and staff accounts are excluded (enforced).
5. **At-least-once notifications.** A future provider must deduplicate by `eventId`; the Resend reset adapter sends an idempotency key.
6. **Backups contain health data.** Backups are integrity-checked and created owner-only, but they are not encrypted at rest by the application. Encrypt the volume or the off-host copy.
7. **Not assessed for compliance.** No HIPAA, DPDP Act 2023 or ISO 27001 assessment has been done. Consent records, data-subject access/erasure workflows, breach notification procedures and a records-retention policy for clinical data do not exist.

## Recommended next security work

1. Revoke the leaked app password and decide whether to rewrite history.
2. ~~Add TOTP MFA for staff~~ (done). Next: offer WebAuthn/passkeys for phishing resistance.
3. Move password hashing off the main thread (worker pool or native argon2id with rehash on login).
4. Add an administrator audit-log viewer with filters (read-only, paginated).
5. Add breached-password screening (k-anonymity range API or an offline list) at registration and reset.
6. Delete the legacy `routes/` and `views/` tree.
7. Run an authenticated DAST scan (for example OWASP ZAP baseline) against a disposable deployment and record the results.
