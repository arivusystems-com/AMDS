# Track 6 Phase 3 — Dynamic Throughput & Warm-up (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** Reputation/warm-up/infra multipliers, effective rate, progressive enforcement, campaign ETA.

See [TRACK-6-PHASE2-COMPLETE.md](./TRACK-6-PHASE2-COMPLETE.md) · [LITEDESK-TRACK-6-PHASE3-DRAFT.md](./LITEDESK-TRACK-6-PHASE3-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `007_throughput.sql` | Done |
| Multiplier resolver (reputation × warm-up × infra) | Done |
| Warm-up engine (Day 1 → Week 3 progression) | Done |
| Worker delivery pacing at effective hourly rate | Done |
| `GET /v1/tenants/:id/throughput` | Done |
| `GET /v1/campaigns/:id/estimate` | Done |
| Progressive enforcement (marketing < 40, suspend < 20) | Done |
| Transactional throughput floor (25% min) | Done |
| Webhook `throughput.updated` | Done |
| Validation | Done — `npm run validate:track-6c` |

---

## Throughput formula

```
Effective Hourly Rate = max_hourly_rate × reputation × warm-up × infra
                      (with transactional floor of 25% on helpdesk queue)
```

Example: max 5,000/hr, reputation 82 (0.75×) → **3,750/hr**

Warm-up Day 1: 5% of combined multiplier after first delivery.

---

## Enforcement

| Condition | Result |
|-----------|--------|
| Reputation < 20 | All sends rejected (`403 reputation_too_low`) |
| Reputation < 40 | Campaign sends rejected (`403 marketing_restricted`) |
| Transaction queue | Minimum 25% throughput floor |

---

## Validate locally

```bash
npm run db:migrate
npm run dev
npm run validate:track-6c
```

**Last updated:** July 2, 2026
