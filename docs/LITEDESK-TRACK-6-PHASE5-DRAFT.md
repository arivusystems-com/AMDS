# LiteDesk Track 6 Phase 5 — Infrastructure Alerts & Recovery UX

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 6 Phase 5 — see [TRACK-6-PHASE5-COMPLETE.md](./TRACK-6-PHASE5-COMPLETE.md)

---

## 1. Goal

Surface platform-level throttling and reputation recovery limits so admins understand why throughput dropped or score recovery is slow.

---

## 2. AMDS APIs to consume

| Endpoint | Use |
|----------|-----|
| `GET /v1/tenants/:id/reputation` | `recovery.day_start_score`, `recovery.remaining_gain_today` |
| `GET /v1/tenants/:id/throughput` | `multipliers.infra` — show when < 1 |
| `GET /v1/admin/infra/status` | Platform ops dashboard (internal) |

---

## 3. UI suggestions

### Settings → Email reputation

Add recovery banner when `remaining_gain_today < 3`:

> Reputation can rise up to **{remaining_gain_today}** more points today. Consistent good sending improves your score over time.

### Campaign composer / throughput card

When `multipliers.infra < 1`:

> Platform is under heavy load. Effective send rate temporarily reduced.

---

## 4. Webhooks

No new webhook types. Continue using `throughput.updated` and `reputation.updated`.

---

*Draft — July 2, 2026*
