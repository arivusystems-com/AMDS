# Incident response runbook

**Service:** AMDS (Arivu Mail Delivery System)  
**On-call scope:** Gateway, workers, Postgres, Redis, SMTP egress

---

## Severity levels

| Level | Example | Response |
|-------|---------|----------|
| S1 | No outbound mail; gateway down | Immediate — all hands |
| S2 | Elevated failures; webhook backlog | < 30 min |
| S3 | Single tenant rate limit; slow campaign | Next business day |

---

## Quick triage (5 minutes)

```bash
# Liveness
curl -s http://<amds-host>:8080/health

# Readiness (DB + Redis)
curl -s http://<amds-host>:8080/ready

# Metrics snapshot
curl -s http://<amds-host>:8080/metrics | grep -E 'amds_queue_jobs|amds_messages_by_status|amds_webhook_outbox'
```

| Check | Healthy | Action if bad |
|-------|---------|---------------|
| `/health` | `status: ok` | Restart gateway; check logs |
| `/ready` | `postgres: true`, `redis: true` | Fix DB/Redis connectivity |
| Queue `waiting` | Stable or draining | Scale workers; check SMTP |
| Queue `failed` | Low | Inspect worker logs, DLQ table |
| `webhook_outbox_pending` | Low | Check LiteDesk webhook URL + firewall |

---

## Common scenarios

### Gateway not responding

1. `systemctl status amds-gateway` or `docker compose ps`
2. Check disk, memory, port bind conflicts
3. Restart: `systemctl restart amds-gateway`
4. Verify: `curl /ready`

### Workers not consuming

1. Confirm Redis reachable from worker host
2. Check worker logs for SMTP errors
3. Restart workers: `systemctl restart 'amds-worker@*'` or scale Docker workers
4. Inspect BullMQ: queue depths in `/metrics`

### All sends failing (SMTP)

1. Confirm `SMTP_MODE=direct` on OCI
2. Test port 25 egress: `nc -vz gmail-smtp-in.l.google.com 25`
3. Check OCI port 25 unblock ticket status
4. Review recent DNS/DKIM changes

### LiteDesk not receiving webhooks

1. Verify `LITEDESK_WEBHOOK_URL` from AMDS host: `curl -v <url>`
2. Check security list: AMDS → LiteDesk webhook port
3. Query `webhook_outbox` for `status = pending` / `exhausted`
4. LiteDesk handler must return 2xx — AMDS retries with backoff

### Elevated queue depth / infra throttling

1. Check `GET /v1/admin/infra/status` — note `infra.multiplier` and `queue_depth`
2. Scale workers: `systemctl restart 'amds-worker@*'` or increase Docker worker replicas
3. If SMTP failure rate high, investigate egress/port 25 before scaling send volume
4. Campaign ETA will increase for all tenants while infra multiplier < 1

### Tenant reputation suspended

1. `GET /v1/tenants/:tenant_id/reputation/guidance` — review reasons and recommendations
2. Check recent bounces/complaints in analytics summary
3. Platform admin: `POST /v1/admin/tenants/:id/reputation` only after root cause fixed
4. Blacklist/spam-trap hits: `POST /v1/admin/tenants/:id/reputation/signal` records audit trail

### Database connection exhaustion

1. Check Postgres connections: `SELECT count(*) FROM pg_stat_activity;`
2. Restart workers if connection leak suspected
3. Scale connection pool limits in gateway/worker

---

## Escalation data to collect

- Time range of incident
- `/metrics` scrape or screenshots
- Gateway + worker logs (JSON, filter by `message_id` or `tenant_id`)
- Sample failed `message_id` from `GET /v1/messages/:id`
- Recent deploys or config changes

---

## Recovery verification

```bash
npm run validate:phase-0a   # from ops jump host with API key
curl -X POST .../v1/messages  # test send
# Confirm Mailpit (local) or real inbox (OCI)
```

---

*Related: [BOUNCE-SPIKE.md](./BOUNCE-SPIKE.md) · [DEPLOY.md](./DEPLOY.md)*
