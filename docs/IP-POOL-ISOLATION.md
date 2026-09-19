# AMDS IP Pool Isolation & Delivery Control

**Status:** Implemented (migration `010_delivery_isolation.sql`)  
**Related:** [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · multi-tenant architecture doc

## Model

Two axes:

| Axis | Values |
|------|--------|
| Purpose | `transaction` · `marketing` |
| Risk tier | `healthy` (≥90) · `standard` (60–89) · `restricted` (&lt;60) |

Marketing pool IDs: `marketing_healthy`, `marketing_standard`, `marketing_restricted` (+ legacy `marketing` → standard).

Transactional mail always uses `transaction` unless dedicated egress is assigned.

## Selection order

1. Dedicated `tenant_egress_assignments` for purpose  
2. Tenant policy `ip_pool` override  
3. Reputation tier → marketing_* pool  

## SMTP bind

Worker passes `localAddress` in **direct** mode. Set real IPs in `ip_pools` / env and `EGRESS_BIND_REQUIRED=true` in production.

## Failure classes

| Class | Affects tenant reputation | Affects infra multiplier |
|-------|---------------------------|--------------------------|
| `infra` | No | Yes |
| `recipient` / `tenant` | Yes | No |

## Ops

- UI: `http://localhost:8080/ops` (enter API key in page)  
- `GET /v1/admin/infra/status`  
- `GET /v1/admin/ip-pools`  
- `GET /v1/admin/ip-inventory`  
- `GET /v1/admin/tenants/:id/routing`  
- Dedicated: `POST /v1/admin/tenants/:id/egress`  

## Easy deploy checklist

1. `npm run setup` (local Mailpit)  
2. `npm run validate:isolation`  
3. OCI: attach IPs → update `ip_pools.egress_ip` + inventory → PTR → `SMTP_MODE=direct` → `EGRESS_BIND_REQUIRED=true`  
4. Open `/ops` for live view  

See [deploy/README.md](../deploy/README.md).

**Full OCI runbook:** [OCI-DEPLOY-END-TO-END.md](./OCI-DEPLOY-END-TO-END.md)
