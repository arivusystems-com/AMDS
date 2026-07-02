# Track 6 Phase 1 — Tenant Policies & Credits (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** Tenant policy sync, credit ledger, static send limits, LiteDesk webhooks for credits/limits.

See [SENDER-REPUTATION-ROADMAP.md](./SENDER-REPUTATION-ROADMAP.md) · [LITEDESK-TRACK-6-PHASE1-DRAFT.md](./LITEDESK-TRACK-6-PHASE1-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `005_tenant_policies.sql` | Done |
| `PUT /v1/tenants/:id/policy` — LiteDesk sync | Done |
| `GET /v1/tenants/:id/policy` | Done |
| `PATCH /v1/tenants/:id/credits` — allocate credits | Done |
| `POST /v1/tenants/:id/suspend` / `activate` | Done |
| Credit reserve → consume → release lifecycle | Done |
| Daily / hourly / burst / campaign size limits | Done |
| Tenant suspended gate | Done |
| Webhooks `credit.*`, `policy.limit_exceeded` | Done |
| `GET /v1/tenants/:id/credits/ledger` (dev only) | Done |
| Validation | Done — `npm run validate:track-6a` |

---

## New env vars

```bash
TENANT_POLICIES_REQUIRED=false   # true in validate:track-6a / production
```

When `false` (default), tenants without a synced policy use legacy global `RATE_LIMIT_*` and no credit checks — existing validate scripts keep working.

---

## API summary

### Sync tenant policy (LiteDesk → AMDS)

```bash
PUT /v1/tenants/{tenant_id}/policy
{
  "status": "active",
  "monthly_credits": 100000,
  "credits_remaining": 80000,
  "daily_send_limit": 20000,
  "max_hourly_rate": 5000,
  "burst_rate_per_min": 100,
  "max_campaign_size": 50000,
  "warmup_enabled": true,
  "reputation_enabled": true
}
```

`0` for any limit field means **unlimited** for that dimension.

### Allocate credits (purchase / subscription renewal)

```bash
PATCH /v1/tenants/{tenant_id}/credits
{ "amount": 10000, "reason": "credit_pack_purchase" }
```

### Send rejection codes

| HTTP | Error | Meaning |
|------|-------|---------|
| 402 | `insufficient_credits` | Not enough credits remaining |
| 403 | `tenant_suspended` | Tenant disabled |
| 403 | `policy_not_found` | Policy required but missing |
| 422 | `campaign_size_exceeded` | Batch larger than `max_campaign_size` |
| 429 | `daily_limit_exceeded` | Daily cap hit |
| 429 | `hourly_limit_exceeded` | Hourly cap hit |
| 429 | `burst_limit_exceeded` | Per-minute burst cap hit |

### Credit lifecycle

1. **Reserve** — on message accept (`credits_remaining` ↓, `credits_reserved` ↑)
2. **Consume** — on worker delivery (`credits_reserved` ↓)
3. **Release** — on permanent failure / dead letter (`credits_remaining` ↑, `credits_reserved` ↓)

Credits and reputation are independent (reputation multipliers come in Phase 3).

---

## Webhooks (AMDS → LiteDesk)

Extend existing `POST /api/internal/webhooks/amds` handler:

| Event | When |
|-------|------|
| `credit.reserved` | Message accepted |
| `credit.consumed` | Message delivered |
| `credit.released` | Reservation cancelled (failure) |
| `policy.limit_exceeded` | Limit check failed |

Payload shape — see [LITEDESK-TRACK-6-PHASE1-DRAFT.md](./LITEDESK-TRACK-6-PHASE1-DRAFT.md).

---

## Validate locally

```bash
npm run db:migrate
npm run dev
npm run validate:track-6a
```

Expected: `Track 6a (AMDS Phase 1) — PASSED`

---

## Next: Phase 2 — Reputation engine

Rolling metrics, sender reputation score (0–100), `reputation.updated` webhooks.

**Last updated:** July 2, 2026
