# Track 6 Phase 4 — Campaign Health & Reputation Guidance (AMDS)

**Status:** Complete (AMDS local — July 2026)  
**Scope:** Per-campaign health score, reputation guidance API, extended analytics.

See [TRACK-6-PHASE3-COMPLETE.md](./TRACK-6-PHASE3-COMPLETE.md) · [LITEDESK-TRACK-6-PHASE4-DRAFT.md](./LITEDESK-TRACK-6-PHASE4-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Campaign health calculator (`packages/shared/src/campaign-health.ts`) | Done |
| Reputation guidance engine (`packages/shared/src/reputation-guidance.ts`) | Done |
| `GET /v1/campaigns/:id/health` | Done |
| `GET /v1/tenants/:id/reputation/guidance` | Done |
| Analytics summary — reputation + campaign health columns | Done |
| Validation | Done — `npm run validate:track-6d` |

---

## Campaign health formula

Campaign health is **independent** of tenant sender reputation. It scores a single campaign using:

| Signal | Weight |
|--------|--------|
| Hard bounce rate | 35% |
| Complaint rate | 35% |
| Delivery rate | 15% |
| Open engagement | 10% |
| Click engagement | 5% |

Example: A campaign with strong delivery and opens but one hard bounce and one complaint will score differently from the tenant's rolling 30-day reputation.

---

## Reputation guidance

`GET /v1/tenants/:id/reputation/guidance` returns:

- Current score, delta, breakdown
- **Reasons** — per-signal status (`passed` / `warning` / `failed`) with score deltas vs prior history
- **Recommendations** — rule-based tips (list hygiene, consent, authentication, volume spikes, content)

---

## Validate locally

```bash
npm run docker:up
npm run dev
npm run validate:track-6d
```

**Last updated:** July 2, 2026
