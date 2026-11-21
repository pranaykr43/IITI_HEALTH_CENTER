# Deployment architecture

This release target is an independent, synthetic-data demonstration. It is not an official IIT Indore system, is not affiliated with or endorsed by IIT Indore, and must not store real medical records or sensitive personal information.

```mermaid
flowchart LR
  Browser -->|HTTPS :443| Caddy
  Caddy -->|private Docker network :3000| Web[Express web]
  Web -->|SQLite WAL| Data[(Persistent health_data volume)]
  Worker[Notification worker] -->|SQLite outbox| Data
  Web -. optional reset only .-> Resend[Resend API]
  Web --> Ready[/readyz]
```

Compose exposes only Caddy on ports 80 and 443. Express and the worker have no host port. Caddy forwards one trusted proxy hop; Express accepts one hop for secure cookies and client address handling. The separate worker waits until the web service reports `/readyz`, then opens the same SQLite file in the named persistent volume. The app applies database migrations during startup.

The worker uses the local console adapter for appointment outbox events. Those events include no email delivery of symptoms, phone, age, prescriptions, or visit notes. Optional Resend is used only for password reset links, with bounded retries. Its adapter logs neither recipient nor link. If no sender is configured, the reset page says no email was sent.

The runtime image is Node 24 Bookworm, builds native SQLite dependencies for ARM64, runs as the unprivileged `node` user, and contains only the application source and runtime scripts. The build context excludes local data, legacy files, tests, reports, environment files, and Git history. SQLite data and Caddy certificates use Docker volumes. Daily database backups are timestamped and checked for SQLite integrity and schema version before being retained.

CI covers maintained Node 24 and Node 26 release lines. Node 22 reached end of life on 20 October 2026, so it is not included. The container remains on Node 24 to match this deployment target; update that pin when the release has a reviewed migration path. [Node.js release schedule](https://nodejs.org/en/about/previous-releases)

Caddy uses its automatic HTTPS behavior for a public hostname and redirects HTTP to HTTPS. Public DNS must point to the VM and ports 80/443 must reach Caddy. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

Primary free-tier target: Oracle Cloud Infrastructure Always Free Ampere A1 VM in the account home region. Oracle lists up to 2 OCPUs / 12 GB RAM equivalent, 200 GB combined block storage and 20 GB object storage (with 50,000 monthly Object Storage API requests for an Always Free-only account). Regional capacity and account eligibility are not guaranteed. Verify the Always Free label and limits in your own account before creating resources. [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

No OCI account, VM, DNS, firewall, Resend sender, OAuth client, or domain is provisioned by this repository. Cloud setup stays an operator-controlled step.
