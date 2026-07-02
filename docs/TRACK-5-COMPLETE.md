# Track 5 — Production Hardening (Local + OCI prep)

**Status:** Complete (local — June 2026)  
**Scope:** Multi-worker scaling, graceful shutdown, Prometheus metrics, runbooks, deploy scaffolding.

See [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [TRACK-4-COMPLETE.md](./TRACK-4-COMPLETE.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Configurable worker concurrency (`TRANSACTION_*`, `WEBHOOK_*`, `CAMPAIGN_*`) | Done |
| Multi-worker via Docker Compose scale / systemd `@` units | Done |
| Graceful shutdown (`SHUTDOWN_GRACE_MS`, production drain) | Done |
| Gateway `GET /metrics` (Prometheus) | Done |
| Worker `GET /metrics` on `:9091` | Done |
| Runbooks (incident, bounce spike, deploy) | Done |
| `docker-compose.prod.yml` + Dockerfiles | Done |
| Terraform OCI skeleton | Done |
| systemd unit templates | Done |
| `deploy/scripts/deploy.sh` | Done |
| Automated validation | Done — `npm run validate:track-5` |
| CI | Done — `.github/workflows/ci.yml` |

---

## New env vars

```bash
TRANSACTION_WORKER_CONCURRENCY=5
WEBHOOK_WORKER_CONCURRENCY=3
SHUTDOWN_GRACE_MS=800          # use 25000 in production
METRICS_ENABLED=true
WORKER_METRICS_PORT=9091
```

---

## Metrics endpoints

| URL | Content |
|-----|---------|
| `GET /metrics` (gateway `:8080`) | HTTP latency, queue depths, message counts, webhook outbox |
| `GET /metrics` (worker `:9091`) | Delivery counters, process metrics |

Restrict via firewall/NSG — no API key required (internal scrape only).

---

## Multi-worker

```bash
# Docker
docker compose -f docker-compose.prod.yml up -d --scale worker=2

# systemd
sudo systemctl enable amds-worker@1 amds-worker@2
sudo systemctl start amds-worker@1 amds-worker@2
```

All workers share the same Redis queues — BullMQ ensures each job is processed once.

---

## Validate locally

```bash
npm run dev
npm run validate:track-5
```

Expected: `Track 5 (AMDS local) — PASSED`

---

## OCI items (manual — at deploy time)

| Item | Where |
|------|-------|
| Port 25 unblock ticket | OCI support |
| `terraform apply` | `deploy/terraform/` |
| PTR / reverse DNS | OCI networking |
| IP warm-up | [runbooks/BOUNCE-SPIKE.md](./runbooks/BOUNCE-SPIKE.md) |
| Load balancer + gateway HA | Post-MVP |

See [runbooks/DEPLOY.md](./runbooks/DEPLOY.md).

---

## Next: OCI deploy

Run full validation suite, then follow [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) deploy day checklist.

**Last updated:** June 30, 2026
