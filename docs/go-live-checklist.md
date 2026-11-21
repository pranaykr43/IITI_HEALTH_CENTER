# Go-live checklist

This means publishing a synthetic engineering demonstration only. It does not authorize real patient or clinical use.

- [ ] Confirm the intended feature revision has passed CI on current supported Node LTS versions, all browser suites, dependency audit, and ARM64 container smoke test.
- [ ] Review Git diff and verify no user-local legacy records, `.env`, database, log, test artifact, or credentials are included.
- [ ] Provision only OCI resources explicitly marked Always Free; verify home region and usage limits. No paid upgrade/resource.
- [ ] Configure DNS, firewall, SSH access, TLS, owner-only `.env`, `PUBLIC_BASE_URL`, secure cookies, and one trusted proxy hop.
- [ ] Start web/Caddy, verify HTTPS `/healthz` and `/readyz`, bootstrap initial admin interactively, then provision a doctor through admin workflow.
- [ ] Start worker and verify health/heartbeat and local console appointment event delivery.
- [ ] Configure verified-domain email only if needed; otherwise confirm the reset page says no email was sent. Never include medical data in email.
- [ ] Complete an integrity-checked backup and off-VM copy; perform and record a disposable restore drill.
- [ ] Verify daily backup schedule and retention, log rotation, disk alert procedure, and recovery contacts.
- [ ] Confirm disclaimers and fictional-only warnings are visible on the landing, registration, appointment, and account recovery surfaces.
- [ ] Owner accepts free-tier capacity/reclamation limits and zero-cost scope; keep production deployment manual and operator-controlled.
