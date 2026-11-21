# Production configuration

The Compose deployment is a **public demonstration** and requires synthetic data only. Copy `production.env.example` to `.env` on the VM, set restrictive file permissions (`chmod 600 .env`), and supply the real host/origin. Never commit `.env`, paste secrets into chat, shell arguments, logs, or issue reports.

Required values:

- `NODE_ENV=production`, `DEMO_MODE=true`, `PORT=3000`
- `HEALTH_DB_PATH=/var/lib/health/data/health-centre.sqlite`
- `PUBLIC_HOST` and `PUBLIC_BASE_URL=https://...` for the DNS name served by Caddy
- `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1` (one Caddy hop), `SESSION_TTL_SECONDS` (at least 60; default 28,800)
- `LOG_LEVEL=info` (valid Pino level)

Notification worker controls are optional. The defaults are a 1-second poll, 30-second claim lease, 5 attempts, 1-second retry base, and 60-second retry cap. `NOTIFICATION_MAX_ATTEMPTS` is hard-limited to 1–10; the exponential delay is capped by `NOTIFICATION_RETRY_MAX_MS`.

Production startup fails closed if secure cookies, the one-hop proxy, the HTTPS origin, or the demonstration flag is absent. Express does not publish its port to the host. Do not set a larger trust proxy hop count.

Optional integrations:

- Password reset email: set both `RESEND_API_KEY` and `EMAIL_FROM`. Verify the sender domain in Resend first and use a sender at that verified domain. The adapter retries only transient network/408/429/5xx failures, at most three attempts, with a stable hashed idempotency key for the same reset link. Resend retains idempotency keys for 24 hours. Delivery runs without delaying the generic account-recovery response, so requests do not wait on the provider. It sends a reset link only; it does not send appointment details or health information. Without both settings, email is disabled and the reset UI clearly says no email was sent. Resend currently publishes a free tier of 3,000 emails/month with a 100/day limit; a domain may still cost money. Recheck current terms before enabling: [Resend pricing](https://resend.com/pricing?product=transactional), [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
- Patient Google sign-in: set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` together. Register the exact HTTPS redirect URI `https://your-host/auth/google/callback` in the provider console. Keep client credentials in `.env`, never in source or logs. Google OAuth is optional; use password sign-in if it is not configured. [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

Generate strong random credentials directly on the VM (for example with the OS cryptographic random source) and write them into the protected `.env` using an editor that does not put secrets in command history. Never pass a secret as a CLI argument, print it, or capture it in CI artifacts. Revoke and rotate any credential that was accidentally exposed.

Initial admin: after deployment, run `docker compose run --rm web npm run admin:create` in an interactive terminal. It accepts no CLI arguments, hides password keystrokes, validates confirmation, creates the admin and `admin.bootstrap` audit record in one SQLite transaction, and refuses to run once any administrator exists. First doctor account creation happens later through the signed-in administrator workflow.
