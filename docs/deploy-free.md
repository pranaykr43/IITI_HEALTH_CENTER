# Deploy for free (Oracle Cloud Always Free)

This puts Health Centre on the public internet with HTTPS for **₹0 a month**, using one Oracle Cloud Always Free ARM virtual machine, a free DuckDNS hostname and Caddy's automatic Let's Encrypt certificates. Total hands-on time is about 30–45 minutes, most of it in the Oracle console.

## Why this host

The app needs a persistent disk (SQLite), an always-on background worker and a public HTTPS address. Most "free" platforms lack one of those:

- **Render's free tier:** no persistent disk.
- **Google Cloud's e2-micro:** its public IPv4 address is billed.
- **Cloudflare Workers:** would need a rewrite.

Oracle's Always Free tier currently includes Ampere A1 compute up to **2 OCPUs and 12 GB RAM** and **200 GB of block storage** in your home region. Oracle reduced the A1 allowance from 4 OCPUs / 24 GB during 2026, so check the [official Always Free resources page](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) and your console's **Limits, Quotas and Usage** before you create anything.

**Costs and caveats, honestly:**

- **Card verification:** sign-up asks for a card to verify identity. Always Free resources are not charged, but **never click "Upgrade to paid"**, and only create resources marked *Always Free-eligible*.
- **Capacity:** A1 capacity is not guaranteed. If creation says "out of host capacity", try another availability domain or retry later. Don't switch to a paid shape.
- **Idle reclamation:** Oracle may reclaim an idle A1 instance (very low CPU, network and memory use over 7 days). Keep off-VM backups, and expect a low-traffic demo to need recreating occasionally.
- **Domain:** a custom domain costs money. DuckDNS gives you a free `yourname.duckdns.org`.

## 1. Create the Oracle Cloud account

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Pick your **home region** carefully, because Always Free compute only exists there and it can't be changed later. Mumbai or Hyderabad are closest for IST users.
2. Finish verification. You'll land in the console with a free-tier account.

## 2. Create the virtual machine

1. Console → **Compute → Instances → Create instance**.
2. **Image:** Canonical Ubuntu 24.04 (the aarch64 build is selected automatically for Ampere).
3. **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **1 OCPU, 6 GB** (comfortable; you can use up to 2 / 12 for free). If Ampere says *out of capacity*, the AMD `VM.Standard.E2.1.Micro` (Always Free, 1 GB RAM) also works; the installer adds 2 GB of swap automatically. Leave **Capacity type** on *On-demand*, not preemptible.
4. **Networking:** keep the default VCN and subnet, with **Assign a public IPv4 address** ticked.
5. **SSH keys:** *Generate a key pair for me* → **download the private key**. Keep it safe; it's the only way in.
6. **Boot volume:** the default (about 47 GB) is fine and within the free 200 GB.
7. Create, wait for **Running**, and copy the **Public IP address**.
8. *(Recommended)* Make the IP permanent: instance → *Attached VNICs* → VNIC → *IPv4 Addresses* → edit → **Reserved public IP**. An ephemeral IP can change if the instance is stopped.

## 3. Open ports 80 and 443 in Oracle's firewall

Oracle blocks web traffic in two places. The installer handles the VM's own firewall; you open the cloud one:

Instance → subnet link → **Security Lists** → *Default Security List* → **Add Ingress Rules**:

| Source CIDR | Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Leave SSH (22) as it is. Don't open 3000; the app is only reachable through Caddy.

## 4. Get a free hostname

**DuckDNS (recommended):**

1. Sign in at [duckdns.org](https://www.duckdns.org) with GitHub or Google.
2. Add a subdomain, for example `iiti-health-demo`. In the **current ip** box, type the VM's public IP and click *update ip*.
3. Your hostname is now `iiti-health-demo.duckdns.org`. Check it with `nslookup iiti-health-demo.duckdns.org` in PowerShell; it should return the VM's IP.

**No sign-up alternative:** `sslip.io` maps names to IPs automatically. For IP `140.238.12.34`, use `140-238-12-34.sslip.io`. It usually works with Let's Encrypt; if certificate issuance fails because of shared rate limits, switch to DuckDNS.

## 5. Connect and install (one command)

From PowerShell on Windows, using the key you downloaded:

```powershell
ssh -i $HOME\Downloads\ssh-key.key ubuntu@YOUR_PUBLIC_IP
```

If SSH complains the key file is too open, fix its permissions once:

```powershell
icacls $HOME\Downloads\ssh-key.key /inheritance:r /grant:r "$($env:USERNAME):R"
```

On the VM, download the installer, read it, then run it with your hostname:

```bash
curl -fsSL https://raw.githubusercontent.com/pranaykr43/IITI_HEALTH_CENTER/main/deploy/install.sh -o install.sh
less install.sh
bash install.sh --host iiti-health-demo.duckdns.org --mode showcase
```

Choose a mode:

| Mode | Use it for | What you get |
|---|---|---|
| `showcase` | A public portfolio or résumé link | Synthetic doctors, patients and two weeks of activity; demo sign-ins printed at the end (safe to publish); data reset every night at 03:30 UTC. Shared demo accounts can't be disabled or locked with 2FA. `NODE_ENV=demo`. |
| `production` | A private, locked-down deployment | No demo data or accounts; staff must use two-factor authentication; you create the first administrator yourself. `NODE_ENV=production`. |

The installer:

- installs Docker;
- opens the VM firewall;
- clones the app to `/opt/health-centre/app`;
- writes a private `.env` with freshly generated secrets;
- builds and starts the containers;
- waits until `https://your-host/readyz` answers;
- schedules daily verified backups.

**After a `production` install:**

```bash
cd /opt/health-centre/app && sudo docker compose run --rm web npm run admin:create
```

Then sign in at `/login/admin`, enrol in two-factor authentication, and copy the `MFA_ENCRYPTION_KEY` line from `/opt/health-centre/app/.env` into your password manager.

## 6. Check it

- Open `https://your-host` and make sure the padlock shows a valid certificate.
- Sign in with the demo accounts (showcase), or with your administrator (production).
- See the containers: `cd /opt/health-centre/app && docker compose ps`. All three should be `running`, and web and worker `healthy`.
- Tail the logs: `docker compose logs -f --tail=50 web worker`.

## 7. Keep it running

| Task | How |
|---|---|
| Deploy a new version | `bash /opt/health-centre/app/deploy/update.sh`. It takes a verified backup, fast-forwards to `main`, rebuilds, checks `/readyz`, and prints a rollback command if anything fails. |
| Free uptime alerts | Create a free monitor at [UptimeRobot](https://uptimerobot.com) or [Better Stack](https://betterstack.com/uptime) for `https://your-host/readyz` (5-minute checks). |
| Metrics (optional) | `curl -H "Authorization: Bearer $(grep ^METRICS_TOKEN= .env \| cut -d= -f2)" https://your-host/metrics` |
| Off-VM backups | Daily backups land in `/opt/health-centre/backups` on the VM. Copy them off the machine, either with Oracle Object Storage (20 GB free; see [oracle-free-tier-setup.md](oracle-free-tier-setup.md) step 8) or by pulling them to your PC: `scp -i $HOME\Downloads\ssh-key.key ubuntu@YOUR_PUBLIC_IP:/opt/health-centre/backups/*.sqlite .` |
| Restore | Follow [backup-and-restore-production.md](backup-and-restore-production.md). |

## 8. Put it on your résumé

- Add the live URL to the top of the README and your résumé, for example "Live demo: https://iiti-health-demo.duckdns.org (synthetic data, resets nightly)".
- In showcase mode, list the three demo sign-ins and the printed password in the README so reviewers can explore every role.
- Link [`case-study.md`](case-study.md) for the engineering story.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Installer stops at "does not resolve yet" | The DNS record isn't set or hasn't propagated. Recheck DuckDNS's *current ip*, then wait a few minutes. |
| Browser shows a certificate warning, or the installer waits on `/readyz` | Ports 80/443 aren't open in the Oracle security list (step 3), or DNS points elsewhere. Fix it, then run `cd /opt/health-centre/app && sudo docker compose restart caddy`. |
| "Out of host capacity" when creating the VM | Try another availability domain, a smaller shape (1 OCPU / 6 GB), or retry later. Don't pick a paid shape. |
| `permission denied ... docker.sock` | Log out and back in once after the installer, so your user's new `docker` group applies, or prefix commands with `sudo`. |
| Site gone after a long idle period | Oracle reclaimed the instance. Create a new VM, rerun the installer, and restore the latest off-VM backup. |
| Want to switch showcase → production | Back up, then edit `.env`: set `NODE_ENV=production` and `STAFF_MFA_REQUIRED=true`, and delete `HEALTH_DEMO_PASSWORD`. Remove `/etc/cron.d/health-centre-showcase-reset`, wipe the demo database (as in `deploy/reset-showcase.sh`, without reseeding), run `sudo docker compose up -d`, then create your administrator. |

Never put real patient, staff or medical information into either mode. This is an independent academic demonstration, not an IIT Indore service.
