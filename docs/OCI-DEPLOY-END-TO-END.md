# AMDS on Oracle OCI — End-to-End Deploy & Setup Guide

**Audience:** Platform / DevOps engineers deploying AMDS for production  
**Related:** [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [runbooks/DEPLOY.md](./runbooks/DEPLOY.md) · [IP-POOL-ISOLATION.md](./IP-POOL-ISOLATION.md) · [deploy/README.md](../deploy/README.md)

This document covers **everything** required to run AMDS on Oracle Cloud Infrastructure (OCI): networking, compute, Postgres/Redis, multi-IP egress, DNS/PTR, application deploy, LiteDesk wiring, warm-up, smoke tests, and ops.

---

## 1. Architecture on OCI (target)

```text
                    ┌─────────────────────────────────────────────┐
                    │                 OCI VCN                       │
                    │                                               │
  Internet ◄──443── │  Public LB / NAT (tracking only)             │
                    │         │                                     │
                    │         ▼                                     │
                    │  ┌─────────────┐     ┌──────────────┐       │
                    │  │ AMDS VM(s)  │◄───►│ Postgres     │       │
                    │  │ gateway     │     │ Redis        │       │
                    │  │ worker×N    │     └──────────────┘       │
                    │  └──────┬──────┘                             │
                    │         │ SMTP :25 (multiple egress IPs)     │
                    │         ▼                                     │
                    │  LiteDesk (same VCN) ◄── webhooks ──► AMDS   │
                    └─────────────────────────────────────────────┘
                              │
                              ▼
                     Recipient MX (Gmail, Outlook, …)
```

**Rules**

| Rule | Why |
|------|-----|
| AMDS and LiteDesk on **separate compute**, same VCN | Email load must not starve CRM |
| API `:8080` **private** (LiteDesk only) | Do not expose `/v1/*` publicly |
| Tracking (`/t/*`, `/c/*`, `/u/*`) may be public via HTTPS | Opens/clicks/unsubscribe |
| Outbound **port 25** required | Direct MX delivery (`SMTP_MODE=direct`) |
| Multiple **public egress IPs** on AMDS VNIC | Reputation pools (Healthy / Standard / Restricted + tx) |

---

## 2. Prerequisites (start early — weeks before cutover)

### 2.1 Accounts & tools

- [ ] OCI tenancy + compartment  
- [ ] OCI CLI / API key (`~/.oci/config`)  
- [ ] Terraform ≥ 1.5 (optional; Console works too)  
- [ ] SSH key for compute  
- [ ] Domain(s) you control (SPF/DKIM/DMARC/PTR)  
- [ ] Node.js 20+ on the AMDS host (or Docker)

### 2.2 OCI port 25 unblock (critical path)

Oracle blocks outbound SMTP by default. Open a **support ticket early** (can take days).

**Ticket template**

> Subject: Request outbound SMTP port 25 for email delivery  
>  
> We operate a self-hosted transactional + marketing email platform (AMDS) on OCI compute  
> `<instance OCID>` in region `<region>`.  
> Egress public IP(s): `<list all sending IPs>`.  
>  
> Purpose: Direct MX delivery (no third-party relay).  
> Expected volume: `<X>` messages/day, ramping per IP warm-up.  
> Controls: bounce/complaint handling, suppressions, DKIM/SPF/DMARC, reputation-tier IP pools.

Until port 25 works: `nc -vz gmail-smtp-in.l.google.com 25` from the AMDS host will fail.

### 2.3 Local exit gates (before production cutover)

On a laptop (Mailpit), confirm:

```bash
npm run setup
npm run dev
npm run validate:phase-0a
npm run validate:track-2   # … through track-6 as needed
npm run validate:isolation
```

Do **not** cut over OCI until local isolation + delivery pipelines pass.

---

## 3. Network design

### 3.1 Recommended layout

| Resource | Recommendation |
|----------|----------------|
| VCN | Shared with LiteDesk (e.g. `10.0.0.0/16`) |
| Private subnet | AMDS + LiteDesk compute, Postgres, Redis |
| Public subnet / NAT | Optional LB for HTTPS tracking; NAT for egress |
| AMDS private IP | e.g. `10.0.1.10` — LiteDesk calls `http://10.0.1.10:8080` |
| AMDS public IPs | 4+ reserved public IPs (see §5) |

### 3.2 Security list / NSG rules

| Direction | Source | Dest | Ports | Purpose |
|-----------|--------|------|-------|---------|
| Ingress | LiteDesk private CIDR | AMDS | TCP 8080 | API + Ops (restrict Ops further if needed) |
| Ingress | Internet (or LB) | AMDS / LB | TCP 443 | Tracking `/t` `/c` `/u` only |
| Egress | AMDS | Internet | TCP 25 | SMTP to MX |
| Egress | AMDS | Internet | UDP/TCP 53 | DNS / MX lookup |
| Egress | AMDS | LiteDesk | TCP 443 or 3000 | Webhooks |
| Egress | AMDS | Postgres/Redis | 5432 / 6379 | Data plane |

**Block:** public ingress to `/v1/*` (API key alone is not enough — network-restrict).

Terraform skeleton: [deploy/terraform/](../deploy/terraform/).

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit compartment_id, region, CIDRs, litedesk_private_ip
terraform init && terraform plan && terraform apply
```

Customize security lists for your real LiteDesk CIDR and tracking LB.

---

## 4. Compute & data plane

### 4.1 AMDS compute sizing (starting point)

| Workload | Shape (example) | Notes |
|----------|-----------------|-------|
| MVP | 2 OCPU / 16 GB | Gateway + 2 workers + Postgres + Redis co-located |
| Growth | Separate DB/Redis; scale workers | Prefer managed Postgres later |

OS: **Oracle Linux 8/9** or **Ubuntu 22.04**. Install Node 20+.

```bash
# Example user layout
sudo useradd -m -s /bin/bash amds
sudo mkdir -p /opt/amds
sudo chown amds:amds /opt/amds
```

### 4.2 PostgreSQL + Redis

**Option A — co-located (MVP)**  
Install Postgres 16 + Redis 7 on the AMDS VM (or Docker Compose prod stack).

**Option B — separate VMs / managed**  
Use OCI Database / Cache with private endpoints; put URLs in `.env`.

Minimum:

```bash
DATABASE_URL=postgresql://amds:<STRONG_PASSWORD>@127.0.0.1:5432/amds
REDIS_URL=redis://127.0.0.1:6379
```

Backups: enable automated Postgres backups before cutover.

### 4.3 Deploy modes

| Mode | When |
|------|------|
| **systemd** (recommended on single VM) | Simple, matches [deploy/systemd/](../deploy/systemd/) |
| **Docker Compose prod** | [docker-compose.prod.yml](../docker-compose.prod.yml) — do **not** enable Mailpit profile in prod |
| Multiple VMs | Same `REDIS_URL` / `DATABASE_URL`; scale workers |

---

## 5. Multi-IP egress (reputation pools) — required for isolation

AMDS selects source IP by purpose + reputation. Those IPs must be **real addresses attached to the VM**.

### 5.1 Minimum IP set

| Role | Example | Used for |
|------|---------|----------|
| Transactional | `A.B.C.10` | Helpdesk / transactional |
| Marketing Healthy | `A.B.C.21` | Score ≥ 90 |
| Marketing Standard | `A.B.C.22` | Score 60–89 |
| Marketing Restricted | `A.B.C.23` | Score &lt; 60 (quarantine) |
| Spare dedicated (optional) | `A.B.C.31+` | Enterprise tenants |

### 5.2 Attach secondary IPs on OCI

1. Console → **Networking → Virtual Cloud Networks** → VNIC of AMDS instance  
2. **IP addresses** → Assign new **public** (or reserved) IPs as secondary  
3. On the OS, ensure addresses are configured (OCI usually injects; verify):

```bash
ip -4 addr show
# Expect primary + secondary public/private mappings as designed
```

4. From the host, confirm each IP can egress (after port 25 unlock):

```bash
# Example bind test (once IPs exist)
curl --interface <EGRESS_IP> -sI https://ifconfig.me || true
```

### 5.3 PTR (reverse DNS)

For **each** sending IP, request PTR → a hostname you control, e.g.:

```text
10.C.B.A.in-addr.arpa.  PTR  mta-tx.mail.yourdomain.com.
21.C.B.A.in-addr.arpa.  PTR  mta-h.mail.yourdomain.com.
…
```

Forward A records for those hostnames should point back to the same IPs (FCrDNS).

Open an OCI networking / support request if Console PTR is unavailable in your tenancy.

### 5.4 Map IPs in AMDS

After migrate, update pools (SQL or admin later):

```sql
UPDATE ip_pools SET egress_ip = 'A.B.C.10', updated_at = NOW() WHERE pool_id = 'transaction';
UPDATE ip_pools SET egress_ip = 'A.B.C.21', updated_at = NOW() WHERE pool_id = 'marketing_healthy';
UPDATE ip_pools SET egress_ip = 'A.B.C.22', updated_at = NOW() WHERE pool_id = 'marketing_standard';
UPDATE ip_pools SET egress_ip = 'A.B.C.23', updated_at = NOW() WHERE pool_id = 'marketing_restricted';
-- Keep legacy marketing alias aligned with standard
UPDATE ip_pools SET egress_ip = 'A.B.C.22', updated_at = NOW() WHERE pool_id = 'marketing';
```

Register inventory (API, with API key):

```bash
export AMDS=http://127.0.0.1:8080
export KEY='<production AMDS_API_KEY>'

for row in \
  "A.B.C.10:transaction:healthy:shared" \
  "A.B.C.21:marketing:healthy:shared" \
  "A.B.C.22:marketing:standard:shared" \
  "A.B.C.23:marketing:restricted:shared"
do
  IFS=: read -r ip purpose tier state <<< "$row"
  curl -s -X POST "$AMDS/v1/admin/ip-inventory" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"egress_ip\":\"$ip\",\"purpose\":\"$purpose\",\"risk_tier\":\"$tier\",\"attached\":true,\"ptr_configured\":true,\"state\":\"$state\"}"
done
```

Spare dedicated IPs: register with `"state":"free"` for later `POST /v1/admin/tenants/:id/egress`.

---

## 6. Application install (systemd path)

### 6.1 Clone & build

```bash
sudo -u amds -i
cd /opt
git clone <YOUR_AMDS_GIT_URL> amds
cd /opt/amds
cp .env.example .env
# Edit .env — see §7
npm ci
npm run build
npm run db:migrate
```

Or after `.env` is ready:

```bash
./deploy/scripts/deploy.sh
```

### 6.2 systemd units

```bash
sudo cp /opt/amds/deploy/systemd/amds-gateway.service /etc/systemd/system/
sudo cp /opt/amds/deploy/systemd/amds-worker@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable amds-gateway amds-worker@1 amds-worker@2
sudo systemctl start amds-gateway amds-worker@1 amds-worker@2
sudo systemctl status amds-gateway 'amds-worker@*'
```

Workers share Redis queues — safe to scale `@3`, `@4`, …

### 6.3 Docker Compose alternative

```bash
# On host: production .env with SMTP_MODE=direct (no mailpit profile)
npm run build
docker compose -f docker-compose.prod.yml up -d --build --scale worker=2
```

Ensure containers can bind host egress IPs (may need `network_mode: host` or explicit secondary IP routing — prefer systemd on first production cutover if multi-IP bind is required).

---

## 7. Production `.env` (complete)

Create `/opt/amds/.env` from `.env.example`, then set:

```bash
NODE_ENV=production
AMDS_PORT=8080

DATABASE_URL=postgresql://amds:<PASSWORD>@127.0.0.1:5432/amds
REDIS_URL=redis://127.0.0.1:6379

# Direct MX delivery (no Mailpit)
SMTP_MODE=direct
# SMTP_HOST / SMTP_PORT unused in direct mode

AMDS_API_KEY=<long random secret>
WEBHOOK_SIGNING_SECRET=<long random secret>
LITEDESK_WEBHOOK_URL=https://litedesk.internal/api/internal/webhooks/amds

TRACKING_BASE_URL=https://track.yourdomain.com
AMDS_SPF_INCLUDE=mail.yourdomain.com
DKIM_DEFAULT_SELECTOR=amds1
ENFORCE_DOMAIN_VERIFICATION=true
DNS_VERIFY_BYPASS=false

SHUTDOWN_GRACE_MS=25000
METRICS_ENABLED=true
WORKER_METRICS_PORT=9091
TRANSACTION_WORKER_CONCURRENCY=5
CAMPAIGN_WORKER_CONCURRENCY=2
WEBHOOK_WORKER_CONCURRENCY=3

TENANT_POLICIES_REQUIRED=true   # after LiteDesk policy sync is live

# Real IPs attached to this host (§5)
EGRESS_IP=A.B.C.10
EGRESS_IP_TRANSACTION=A.B.C.10
EGRESS_IP_MARKETING=A.B.C.22
EGRESS_IP_MARKETING_HEALTHY=A.B.C.21
EGRESS_IP_MARKETING_STANDARD=A.B.C.22
EGRESS_IP_MARKETING_RESTRICTED=A.B.C.23
EGRESS_BIND_REQUIRED=true

OPS_UI_ENABLED=true             # restrict /ops via NSG or reverse proxy auth in hardened setups
```

Store secrets in **OCI Vault** long-term; inject via instance principal / deploy script ([deploy/README.md](../deploy/README.md)).

---

## 8. DNS for platform + tenant domains

### 8.1 Platform / tracking

| Record | Example | Purpose |
|--------|---------|---------|
| A/AAAA or CNAME | `track.yourdomain.com` → LB / AMDS | Open/click/unsub |
| SPF include | `include:mail.yourdomain.com` | Shared policy helper |
| A | `mta-tx.mail.yourdomain.com` → tx IP | Align with PTR |

Reverse proxy (nginx/Caddy) terminates TLS for tracking and proxies to `127.0.0.1:8080` **only** for `/t/`, `/c/`, `/u/` paths if you want API private.

### 8.2 Per-tenant sending domains

1. LiteDesk/admin: `POST /v1/domains` for tenant  
2. AMDS returns SPF / DKIM / DMARC records  
3. Customer (or you) publishes DNS  
4. `POST /v1/domains/:id/verify`  
5. With `ENFORCE_DOMAIN_VERIFICATION=true`, unverified domains cannot send

### 8.3 Bounce domain (when live inbound bounce is enabled)

Plan `bounce.yourdomain.com` → AMDS inbound SMTP (future/live DSN listener). Until then, use admin simulate + ISP feedback processes carefully.

---

## 9. LiteDesk integration

On the **LiteDesk** host `.env` (or config):

```bash
AMDS_BASE_URL=http://10.0.1.10:8080          # AMDS private IP
AMDS_API_KEY=<same as AMDS AMDS_API_KEY>
AMDS_WEBHOOK_SECRET=<same as WEBHOOK_SIGNING_SECRET>
```

AMDS must reach LiteDesk:

```bash
LITEDESK_WEBHOOK_URL=https://litedesk.internal/api/internal/webhooks/amds
```

Sync tenant policies (`PUT /v1/tenants/:id/policy`) before enabling `TENANT_POLICIES_REQUIRED=true`.

---

## 10. IP warm-up (first 2 weeks)

Do **not** blast full volume on day 1.

| Days | Cap guidance (per egress IP) |
|------|------------------------------|
| 1–3 | ~500/day |
| 4–7 | ~2,000/day |
| 8–14 | ~10,000/day |
| 15+ | Raise carefully; watch bounces/complaints |

AMDS enforces egress warm-up caps in code (`egress_ip_state`). Still ramp **marketing** carefully; keep transactional volume stable.

Monitor:

- `/ops` or `GET /v1/admin/infra/status`  
- `GET /metrics` (gateway)  
- Bounce spike runbook: [runbooks/BOUNCE-SPIKE.md](./runbooks/BOUNCE-SPIKE.md)

---

## 11. Cutover checklist (deploy day)

1. [ ] Port 25 confirmed open from AMDS host  
2. [ ] Secondary IPs attached + visible in `ip addr`  
3. [ ] PTR live for each sending IP  
4. [ ] `.env` production values set; secrets strong  
5. [ ] `npm run build` + `npm run db:migrate` (includes `010_delivery_isolation`)  
6. [ ] `ip_pools.egress_ip` + inventory updated to real IPs  
7. [ ] `EGRESS_BIND_REQUIRED=true`, `SMTP_MODE=direct`  
8. [ ] systemd (or Compose) gateway + ≥2 workers running  
9. [ ] NSG: LiteDesk → `:8080`; public API blocked  
10. [ ] Tracking HTTPS live  
11. [ ] LiteDesk env pointed at AMDS private URL  
12. [ ] Tenant domain verified (SPF/DKIM/DMARC)  
13. [ ] Smoke tests (§12) pass  

---

## 12. Post-deploy smoke tests

```bash
# On AMDS host
curl -s http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/ready

# From LiteDesk host
curl -s http://<amds-private-ip>:8080/ready \
  -H "Authorization: Bearer $AMDS_API_KEY"
```

| Test | Expected |
|------|----------|
| Helpdesk / transactional send | Lands in real Gmail/Outlook; source IP = transactional |
| Campaign send (healthy tenant) | Lands; source IP = marketing healthy/standard |
| Webhook | `message.delivered` in LiteDesk |
| mail-tester.com | ≥ ~8/10 with auth aligned |
| Ops UI | `http://<amds-private>:8080/ops` — pools + infra visible |
| Routing | `GET /v1/admin/tenants/:id/routing` shows correct pools |
| Isolation | Lower test tenant score → campaigns resolve `marketing_restricted` |
| Intentional hard bounce | Suppression + reputation signal (live bounce path when available) |

Confirm source IP (headers / receiving logs / packet capture) matches pool selection.

---

## 13. Ops & day-2 runbooks

| Topic | Doc |
|-------|-----|
| Isolation model | [IP-POOL-ISOLATION.md](./IP-POOL-ISOLATION.md) |
| Incidents | [runbooks/INCIDENT.md](./runbooks/INCIDENT.md) |
| Bounce spikes | [runbooks/BOUNCE-SPIKE.md](./runbooks/BOUNCE-SPIKE.md) |
| Deploy / rollback | [runbooks/DEPLOY.md](./runbooks/DEPLOY.md) |

Useful endpoints (API key required except health/metrics as configured):

| Endpoint | Use |
|----------|-----|
| `GET /ops` | Ops UI |
| `GET /v1/admin/infra/status` | Queue + infra multiplier + pools |
| `GET /v1/admin/ip-pools` | Pool → egress map |
| `GET /v1/admin/ip-inventory` | Free / assigned IPs |
| `POST /v1/admin/tenants/:id/egress` | Dedicated IP assign |
| `GET /metrics` | Prometheus scrape (NSG-restrict) |

**Rollback:** stop workers → point LiteDesk off AMDS or to prior env → stop gateway (grace) → investigate ([DEPLOY.md](./runbooks/DEPLOY.md)).

---

## 14. What remains after this guide (known gaps)

| Item | Notes |
|------|--------|
| Live inbound bounce SMTP / FBL | Production feedback loop; simulate exists locally |
| OCI Vault injection automation | Recommended hardening |
| Multi-region HA / LB for API | Post-MVP |
| Per-tenant dedicated IPs at scale | Inventory workflow ready; attach IPs as needed |

---

## 15. Quick reference — commands

```bash
# Deploy / restart
cd /opt/amds && ./deploy/scripts/deploy.sh
sudo systemctl restart amds-gateway 'amds-worker@*'

# Logs
journalctl -u amds-gateway -f
journalctl -u amds-worker@1 -f

# Health
curl -s http://127.0.0.1:8080/ready

# Port 25 check
nc -vz gmail-smtp-in.l.google.com 25
```

---

**Last updated:** September 2026
