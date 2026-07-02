# OCI deploy runbook

**When:** All local track exit gates pass (`validate:phase-0a` through `validate:track-5`).

See [BUILD-TO-DEPLOY.md](../BUILD-TO-DEPLOY.md) for strategy overview.

---

## Pre-deploy (parallel — start weeks early)

- [ ] Open OCI **port 25 unblock** support ticket
- [ ] Customize `deploy/terraform/terraform.tfvars`
- [ ] Plan DNS records (SPF, DKIM, DMARC, `track.*`, `bounce.*`)
- [ ] Plan internal DNS (`amds.internal`, `litedesk.internal`)
- [ ] LiteDesk Track 3+ integration verified locally

---

## Provision infrastructure

```bash
cd deploy/terraform
terraform init && terraform plan && terraform apply
# Note amds_private_ip output
```

Security lists (verify):

| Source | Destination | Port | Purpose |
|--------|-------------|------|---------|
| LiteDesk private IP | AMDS private IP | 8080 | API |
| AMDS private IP | LiteDesk private IP | 443/3000 | Webhooks |
| Internet | AMDS public IP | 443 | Tracking only |
| AMDS | Internet | 25, 587, 53 | SMTP + DNS |

**Block** public access to AMDS `/v1/*`.

---

## Application deploy

```bash
# On AMDS compute (as amds user)
git clone <repo> /opt/amds
cd /opt/amds
cp .env.example .env
# Edit .env — production values below
npm ci && npm run build && npm run db:migrate

# systemd (recommended)
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl enable amds-gateway amds-worker@1 amds-worker@2
sudo systemctl start amds-gateway amds-worker@1 amds-worker@2

# Or use deploy/scripts/deploy.sh after .env is configured
```

### Production `.env` highlights

```bash
NODE_ENV=production
SMTP_MODE=direct
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
LITEDESK_WEBHOOK_URL=https://litedesk.internal/api/internal/webhooks/amds
TRACKING_BASE_URL=https://track.yourdomain.com
SHUTDOWN_GRACE_MS=25000
ENFORCE_DOMAIN_VERIFICATION=true
DNS_VERIFY_BYPASS=false
METRICS_ENABLED=true
```

---

## DNS + PTR

1. Register customer sending domains via AMDS `POST /v1/domains`
2. Apply SPF, DKIM, DMARC TXT records from AMDS response
3. CNAME `track.customer.com` → AMDS tracking endpoint
4. Request **PTR record** for AMDS egress IP (OCI support / networking team)

---

## Post-deploy smoke tests

```bash
curl https://amds.internal:8080/ready
# From LiteDesk host — send helpdesk reply → real Gmail/Outlook inbox
# Confirm webhook message.delivered in LiteDesk
# mail-tester.com score ≥ 8/10
# One intentional hard bounce → suppression + webhook
```

---

## Rollback

1. Stop workers: `systemctl stop 'amds-worker@*'`
2. Point LiteDesk `AMDS_BASE_URL` to previous environment (or disable AMDS provider)
3. Gateway drain: `systemctl stop amds-gateway` (grace period 30s)
4. Investigate; fix forward

---

## Port 25 unblock ticket template

> Subject: Request outbound SMTP port 25 for email delivery  
>  
> We operate a self-hosted transactional email platform (AMDS) on OCI compute  
> `<instance OCID>` in region `<region>`. Egress IP: `<public IP>`.  
>  
> Purpose: Direct MX delivery to recipient mail servers (no relay).  
> Expected volume: `<X>` messages/day, ramping per IP warm-up schedule.  
>  
> We implement bounce handling, suppression lists, and DKIM/SPF/DMARC.

---

*Related: [deploy/README.md](../../deploy/README.md) · [INCIDENT.md](./INCIDENT.md)*
