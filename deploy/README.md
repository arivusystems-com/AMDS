# AMDS deployment

Production artifacts for OCI and Docker-based deploys.

## Layout

| Path | Purpose |
|------|---------|
| `Dockerfile.gateway` | Gateway container image |
| `Dockerfile.worker` | Worker container image (scale horizontally) |
| `docker-compose.prod.yml` | Full stack (repo root) |
| `systemd/` | Unit files for bare-metal OCI compute |
| `terraform/` | OCI VCN + compute skeleton |
| `scripts/deploy.sh` | Post-provision app deploy helper |

## Local production simulation

```bash
npm run build
cp .env.example .env   # adjust for production values
docker compose -f docker-compose.prod.yml --profile local-smtp up -d --build
docker compose -f docker-compose.prod.yml up -d --scale worker=2
curl http://localhost:8080/metrics
```

## Multi-worker (BullMQ)

Run **multiple worker processes** against the same Redis queues. BullMQ coordinates job ownership — no duplicate delivery.

Options:

1. **Docker Compose:** `--scale worker=N`
2. **systemd:** enable multiple `amds-worker@.service` instances
3. **OCI:** N compute instances or containers, same `REDIS_URL`

Tune concurrency via env:

```bash
TRANSACTION_WORKER_CONCURRENCY=5
CAMPAIGN_WORKER_CONCURRENCY=2
WEBHOOK_WORKER_CONCURRENCY=3
```

## Metrics

| Endpoint | Service | Auth |
|----------|---------|------|
| `GET /metrics` | Gateway `:8080` | None — restrict via NSG/firewall |
| `GET /metrics` | Worker `:9091` | None — internal only |

Set `METRICS_ENABLED=false` to disable.

## Secrets (OCI Vault)

For production, store sensitive values in **OCI Vault** rather than plain `.env` on disk:

| Secret | Used by |
|--------|---------|
| `AMDS_API_KEY` | Gateway auth |
| `WEBHOOK_SIGNING_SECRET` | Outbound webhooks to LiteDesk |
| `DATABASE_URL` | Gateway + worker |
| `REDIS_URL` | Gateway + worker |
| DKIM private keys | Already in Postgres `domains` table — restrict DB access |

Inject at runtime via instance principal or deploy script; never commit to git.

Track 6 policy data is synced from LiteDesk — no additional Vault keys required for entitlements.

## OCI checklist

See [docs/BUILD-TO-DEPLOY.md](../docs/BUILD-TO-DEPLOY.md) and [docs/runbooks/DEPLOY.md](../docs/runbooks/DEPLOY.md).

1. Open port 25 unblock ticket (parallel with local build)
2. `terraform apply` in `deploy/terraform/` (customize `terraform.tfvars`)
3. SSH to AMDS compute → run `deploy/scripts/deploy.sh`
4. Configure security lists (LiteDesk → AMDS `:8080`, block public `/v1/*`)
5. DNS + PTR + smoke tests
