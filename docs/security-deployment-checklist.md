# Security deployment checklist

- [ ] Public interface labels the site an independent demonstration, not endorsed by IIT Indore or a live campus service; synthetic-only data warning appears on key entry points.
- [ ] `DEMO_MODE=true`; no real patient, clinical, or staff records are imported.
- [ ] `.env` is owner-only, untracked, excluded from Docker context, and has no default demo password.
- [ ] Strong admin password created interactively after startup; first doctor provisioned through authenticated admin workflow.
- [ ] Node 24 LTS image, non-root runtime, ARM64 build smoke test, only Caddy ports public.
- [ ] DNS A record points to the VM; Caddy certificate is valid; `/readyz` succeeds over HTTPS.
- [ ] `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1`, valid HTTPS `PUBLIC_BASE_URL`; no direct public access to port 3000.
- [ ] Google credentials are optional, callback exact and HTTPS. Resend is optional and sender domain verified.
- [ ] Reset-email behavior does not claim delivery when disabled; no appointment/clinical details are sent by email.
- [ ] Pino HTTP logs omit query strings and redact authorization, cookies, CSRF tokens, password and reset token fields. Requests and bodies are not logged.
- [ ] Docker log rotation is enabled; no database files, env files, legacy JSON records, Playwright reports, or tests are in the image.
- [ ] Worker and web use the same persistent SQLite volume; worker waits for readiness and heartbeat is healthy.
- [ ] Daily backup passes SQLite integrity and schema-version validation, retention is configured, and an off-VM copy exists.
- [ ] Restore drill was completed against a disposable database and documented, then the production DB was left untouched.
- [ ] OCI resources are all shown as Always Free and within limits; account remains un-upgraded to paid; usage alerts and reclaim risk are understood.
- [ ] No secret scan findings remain in source/history; rotate any leaked credential at its provider.

This app is not assessed or approved for handling real medical information. Do not add real data to “test” the deployment.
