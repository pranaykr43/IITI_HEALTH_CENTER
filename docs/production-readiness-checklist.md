# Production readiness checklist

**Updated:** 2026-11-21

**Current verdict: not ready for real patient data.** The application is suitable for a publicly reachable *synthetic* demonstration once the items marked **Required before any public deployment** are complete. Handling real health information would additionally require the items under "Required before real data", none of which are done.

Legend: ✅ verified on this branch · ⚠️ implemented but not verified end-to-end · ❌ missing · 🔑 needs external infrastructure, credentials or an owner decision.

## Required before any public deployment

| | Item | Evidence / how to verify |
|---|---|---|
| 🔑 | Revoke the leaked Gmail app password (audit P0-1) | Owner confirms in Google account security settings |
| ✅ | Dependencies install and tests pass on Node 24 | `npm ci && npm run check` (87 tests, lint clean) |
| ✅ | No known vulnerable dependencies | `npm audit` → 0 vulnerabilities |
| ✅ | Browser suites pass | `npm run test:e2e` — 39/39 across Chromium, Firefox and WebKit |
| ⚠️ | CI green on the merged commit (Node 24/26, three-browser e2e, ARM64 container smoke) | Check the GitHub Actions run for the merge commit |
| ⚠️ | Container image builds and starts | Docker not available on the audit machine; covered by CI `arm64-container` |
| 🔑 | DNS, TLS via Caddy, firewall exposing only 80/443 | `curl -I https://<host>/healthz`; port 3000 not reachable externally |
| 🔑 | `.env` owner-only with `NODE_ENV=production`, `DEMO_MODE=true`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`, HTTPS `PUBLIC_BASE_URL`, absolute `HEALTH_DB_PATH`, `CLINIC_TIMEZONE` | Startup refuses unsafe values (`test/config.test.js`) |
| 🔑 | `MFA_ENCRYPTION_KEY` set (32 random bytes) and backed up separately from database backups | Startup refuses production without it (`test/mfa.test.js`) |
| 🔑 | First administrator enrols in two-factor authentication immediately after `npm run admin:create` | Dashboard accounts table shows 2FA "On" |
| 🔑 | `METRICS_TOKEN` set (≥ 32 random characters) if metrics are scraped; otherwise `/metrics` returns 404 | `curl -H "Authorization: Bearer …" https://<host>/metrics` |
| 🔑 | Initial administrator created with `npm run admin:create` (interactive, production only) | Audit row `admin.bootstrap` |
| ✅ | Demo seeding disabled in production | `test/config.test.js` |
| ⚠️ | Notification worker running with the same database volume; heartbeat healthy | Dashboard "Worker last seen"; `health_centre_worker_heartbeat_age_seconds` < 60 (worker verified locally) |
| ✅ | Session, reset and OAuth artefacts purged automatically | Hourly housekeeping; `test/hardening.test.js` |
| 🔑 | Daily verified backup scheduled with retention and an off-host copy | `scripts/install-backup-cron.sh`; check the newest backup passes `validateDatabase` |
| 🔑 | Restore drill performed on a disposable host and recorded | `docs/backup-and-restore-production.md` |
| ✅ | Footer and forms state this is an independent demonstration using fictional data | Product-direction tests |

## Recommended monitoring and alert thresholds

Scrape `/metrics` with the bearer token every 30–60 seconds.

| Signal | Alert when | Why |
|---|---|---|
| `/readyz` external probe | Non-200 for 2 consecutive minutes | Database unavailable or process down |
| `health_centre_worker_heartbeat_age_seconds` | > 120 or = -1 for 5 minutes | Worker stopped; notifications not leaving |
| `health_centre_outbox_events{status="dead"}` | > 0 | Delivery exhausted retries; needs redrive or investigation |
| `health_centre_outbox_oldest_pending_age_seconds` | > 600 | Backlog or stuck worker |
| `rate(health_centre_http_errors_total[5m])` | > 1% of `health_centre_http_requests_total` | Server errors |
| Disk usage on the data volume | > 80% | SQLite WAL growth and backups |
| Newest backup age | > 26 hours | Backup job failing |

## Required before real data (not started)

| | Item |
|---|---|
| ❌ | Legal and compliance assessment for the jurisdiction (for example India's DPDP Act 2023; HIPAA if US entities are involved), data-processing agreements with any provider |
| ❌ | Consent capture, privacy notice, data-subject access/correction/erasure workflows, documented retention schedule for clinical records |
| ✅ | TOTP MFA required for staff accounts (`STAFF_MFA_REQUIRED=true`, production default); phishing-resistant WebAuthn still ❌ |
| ❌ | Encryption at rest for the database volume and backups, with key management |
| ❌ | Independent penetration test and remediation |
| ❌ | Incident response and breach-notification runbook with named contacts |
| ❌ | Deployed alerting and on-call ownership |
| ❌ | High-availability plan, if required (would trigger the architecture review in the roadmap) |
| 🔑 | Real notification provider configured, reviewed for data minimisation, deduplicating by event ID |
| 🔑 | Google OAuth verified end-to-end against the production client and consent screen |

## Release procedure (per change)

1. `npm ci && npm run check && npm run test:e2e` locally on Node 24.
2. Review `git diff` for secrets, local data exports, `.env`, databases and test artefacts (the `.gitignore` excludes the known legacy export names).
3. Open a pull request; require CI to pass.
4. Take a verified backup (`npm run db:backup -- <path>`) before deploying a change that includes a migration. Migration 5 revokes all existing sessions once.
5. Deploy, then check `/readyz`, sign in as each role, and check worker heartbeat and metrics.
