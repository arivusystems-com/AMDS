# Track 6 Phase 6 — Enterprise Hardening (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** IP pools, read replica support, OpenAPI, load smoke test, security runbook.

See [TRACK-6-COMPLETE.md](./TRACK-6-COMPLETE.md) · [openapi-track6.yaml](./openapi-track6.yaml)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `009_ip_pools.sql` | Done |
| Dedicated IP pools (transaction vs marketing) | Done |
| Tenant policy `ip_pool` override | Done |
| Worker egress routing by pool + queue | Done |
| `GET /v1/admin/ip-pools` | Done |
| Read replica (`DATABASE_READ_URL`) for reputation history | Done |
| OpenAPI spec `GET /v1/openapi.yaml` | Done |
| Load smoke test script | Done — `npm run validate:track-6f` |
| Security test runbook | Done — [runbooks/SECURITY-TEST.md](./runbooks/SECURITY-TEST.md) |
| OCI Vault guidance | Done — [deploy/README.md](../deploy/README.md) |

---

## IP pools

| Pool | Default egress key | Used for |
|------|-------------------|----------|
| `transaction` | `default-tx` (or `EGRESS_IP_TRANSACTION`) | Helpdesk / `POST /v1/messages` |
| `marketing` | `default-mkt` (or `EGRESS_IP_MARKETING`) | Campaigns / `POST /v1/campaigns/:id/messages` |

Override per tenant via `ip_pool` on policy sync.

---

## Load testing

CI runs a **20-message** campaign smoke (`LOAD_TEST_SIZE=20`).

For manual 10K+ test:

```bash
LOAD_TEST_SIZE=10000 npm run validate:track-6f
```

Monitor `/metrics` for queue depth and infra multiplier during the run.

---

## Validate

```bash
npm run validate:track-6f
npm run validate:track-6   # all Track 6 phases
```

**Last updated:** July 2, 2026
