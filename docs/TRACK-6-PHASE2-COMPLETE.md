# Track 6 Phase 2 — Sender Reputation Engine (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** Rolling metrics, continuous 0–100 reputation score, history API, webhooks, complaint simulation.

See [SENDER-REPUTATION-ROADMAP.md](./SENDER-REPUTATION-ROADMAP.md) · [TRACK-6-PHASE1-COMPLETE.md](./TRACK-6-PHASE1-COMPLETE.md) · [LITEDESK-TRACK-6-PHASE2-DRAFT.md](./LITEDESK-TRACK-6-PHASE2-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `006_reputation.sql` | Done |
| Weighted score calculator (`packages/shared/src/reputation.ts`) | Done |
| Event-driven signal ingestion | Done |
| Rolling windows (7d complaints, 30d bounces/delivery/engagement, 14d consistency) | Done |
| Domain authentication factor | Done |
| `GET /v1/tenants/:id/reputation` | Done |
| `GET /v1/tenants/:id/reputation/history` | Done |
| `POST /v1/admin/tenants/:id/reputation` — admin override | Done |
| `POST /v1/admin/simulate-complaint` | Done |
| Webhook `reputation.updated` | Done |
| Webhook `message.complained` | Done |
| Validation | Done — `npm run validate:track-6b` |

---

## Score weights (from architecture spec)

| Metric | Weight |
|--------|--------|
| Hard bounce rate (30d) | 30% |
| Spam complaints (7d) | 30% |
| Delivery rate (30d) | 15% |
| Open rate (30d) | 10% |
| Click rate (30d) | 5% |
| Authentication (current) | 5% |
| Sending consistency (14d) | 5% |

Score updates are capped by `REPUTATION_MAX_DELTA` (default 5) per event to prevent wild swings.

---

## Signal sources

| Signal | Trigger |
|--------|---------|
| `delivered` | Worker after successful SMTP |
| `hard_bounce` / `soft_bounce` | Bounce handler |
| `complaint` | Complaint handler / simulate |
| `open` / `click` | Tracking (first hit only) |

Skipped when tenant policy has `reputation_enabled: false`.

---

## New env vars

```bash
REPUTATION_DEFAULT_SCORE=70
REPUTATION_MAX_DELTA=5
```

---

## Validate locally

```bash
npm run db:migrate
npm run dev
npm run validate:track-6b
```

---

## Next: Phase 3 — Dynamic throughput & warm-up

Reputation multiplier applied to effective hourly rate, warm-up engine, campaign ETA.

**Last updated:** July 2, 2026
