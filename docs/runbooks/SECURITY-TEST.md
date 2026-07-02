# Security test checklist (Track 6)

**Scope:** Policy sync auth, credit manipulation, API key enforcement  
**When:** Before production cutover and after major Track 6 changes

---

## Authentication

- [ ] All `/v1/*` routes reject missing `Authorization` header (401)
- [ ] Invalid API key returns 401
- [ ] `/health`, `/ready`, `/metrics`, `/v1/openapi.yaml` accessible without auth (expected)
- [ ] Admin simulate endpoints return 404 in `NODE_ENV=production`

## Policy sync (LiteDesk → AMDS)

- [ ] Cannot set another tenant's policy without knowing tenant id + valid API key
- [ ] Negative `credits_remaining` rejected at schema validation
- [ ] Suspend/activate idempotent and audited in `credit_ledger` / events

## Credit manipulation

- [ ] Credits decrement only on delivery (not on queue accept alone beyond reserve)
- [ ] Failed/dead-letter releases reservation (`credit.released`)
- [ ] Duplicate idempotency key does not double-charge credits
- [ ] `PATCH /credits` cannot drive balance negative via single request

## Reputation

- [ ] Tenants cannot self-override reputation (admin route only)
- [ ] Daily recovery cap prevents > `REPUTATION_MAX_DAILY_GAIN` organic rise per UTC day
- [ ] Blacklist/spam_trap signals require admin API key

## Rate limits

- [ ] Burst/hourly/daily limits enforced per tenant policy
- [ ] Marketing blocked below reputation 40
- [ ] All sends blocked below reputation 20

## Webhooks (AMDS → LiteDesk)

- [ ] LiteDesk verifies HMAC signature on inbound webhooks
- [ ] Replay of same `event_id` ignored (idempotent)

## Recommended tools

- Manual curl with wrong/missing API keys
- `npm run validate:track-6a` through `6f` in CI
- Optional: OWASP ZAP against gateway (staging only)

---

*Related: [INCIDENT.md](./INCIDENT.md) · [TRACK-6-COMPLETE.md](../TRACK-6-COMPLETE.md)*
