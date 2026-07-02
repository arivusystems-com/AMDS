# Track 6 Phase 5 — Infrastructure Protection & Recovery (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** Enhanced infra multiplier, egress IP warm-up, recovery curve, negative signals, Prometheus gauges.

See [TRACK-6-PHASE4-COMPLETE.md](./TRACK-6-PHASE4-COMPLETE.md) · [LITEDESK-TRACK-6-PHASE5-DRAFT.md](./LITEDESK-TRACK-6-PHASE5-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `008_infra_protection.sql` | Done |
| Enhanced infra multiplier (queue + SMTP failure rate) | Done |
| Egress IP warm-up caps (500 → 2K → 10K → unlimited) | Done |
| Daily reputation recovery cap | Done |
| Blacklist / spam-trap admin signals | Done |
| Prometheus gauges (`amds_infra_multiplier`, tenant reputation/rate) | Done |
| Admin infra status + simulate pressure (dev) | Done |
| Runbook updates | Done |
| Validation | Done — `npm run validate:track-6e` |

---

## Infra multiplier

```
Effective infra = min(queueDepthMultiplier, smtpFailureMultiplier)
```

SMTP failure rate is tracked over a rolling window (`INFRA_SMTP_WINDOW_MINUTES`, default 5).

---

## Recovery curve

Organic reputation gains are capped at `REPUTATION_MAX_DAILY_GAIN` (default 5) above the UTC day-start score. Exposed on `GET /v1/tenants/:id/reputation` as `recovery.remaining_gain_today`.

---

## Validate locally

```bash
npm run db:migrate
npm run dev
npm run validate:track-6e
```

**Last updated:** July 2, 2026
