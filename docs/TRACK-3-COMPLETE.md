# Track 3 — Domain Auth, Bounces, Scheduling (Local)

**Status:** Complete (June 2026)  
**Scope:** Domain registration, DNS records, DKIM signing, suppressions, scheduled send, bounce parsing/simulation, webhooks v2.

See [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [TRACK-2-COMPLETE.md](./TRACK-2-COMPLETE.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `003_track3.sql` — `domains`, `suppressions`, `scheduled_at` | Done |
| `POST /v1/domains` — register domain + DKIM key generation | Done |
| `GET /v1/domains/:domain?tenant_id=` | Done |
| `POST /v1/domains/:domain/verify` — SPF/DKIM/DMARC DNS checks | Done |
| DKIM signing in worker (verified domains) | Done |
| `GET/POST/DELETE /v1/suppressions` | Done |
| Suppression check on send → `422` | Done |
| `scheduled_at` on `POST /v1/messages` (BullMQ delay) | Done |
| Bounce parser (`packages/shared/src/bounce.ts`) | Done |
| `POST /v1/admin/simulate-bounce` (non-production) | Done |
| Webhooks `message.bounced` | Done |
| `npm run simulate:bounce` CLI | Done |
| Automated validation | Done — `npm run validate:track-3` |
| CI | Done — `.github/workflows/ci.yml` |

---

## New env vars

```bash
AMDS_SPF_INCLUDE=amds.local
DKIM_DEFAULT_SELECTOR=amds1
DNS_VERIFY_BYPASS=false          # true in CI / local validation
ENFORCE_DOMAIN_VERIFICATION=false # true to require verified from-domain
```

---

## API summary

### Domains

```bash
# Register
POST /v1/domains
{ "tenant_id": "org_abc", "domain": "customer.com" }

# DNS records + status
GET /v1/domains/customer.com?tenant_id=org_abc

# Verify DNS
POST /v1/domains/customer.com/verify
{ "tenant_id": "org_abc" }
```

### Suppressions

```bash
GET /v1/suppressions?tenant_id=org_abc
POST /v1/suppressions { "tenant_id", "email", "reason" }
DELETE /v1/suppressions/user@example.com?tenant_id=org_abc
```

### Scheduled send

```json
POST /v1/messages
{
  "scheduled_at": "2026-06-30T12:00:00.000Z",
  ...
}
```

Message `status` is `scheduled` until the worker delivers.

### Bounce simulation (dev/test only)

```bash
npm run simulate:bounce -- <message_id> <tenant_id> hard
# or
POST /v1/admin/simulate-bounce
```

Hard bounces auto-add the recipient to suppressions and emit `message.bounced`.

---

## Validate locally

```bash
npm run db:migrate
DNS_VERIFY_BYPASS=true ENFORCE_DOMAIN_VERIFICATION=true npm run dev
npm run validate:track-3
```

Expected: `Track 3 (AMDS local) — PASSED`

---

## LiteDesk (separate repo)

**Status:** Complete (June 30, 2026)

| Item | Status |
|------|--------|
| `AmdsApiError` + domain/suppression client methods | Done |
| Webhook `message.bounced` → Communication + case activity | Done |
| Hard bounce → `EmailSuppression` + AMDS `createSuppression` | Done |
| Agent IN_APP notification on failed/bounce | Done |
| Send 422 (suppressed) / 403 (domain) — sync + queue `sendErrorCode` | Done |
| `scheduled_at` on outbound AMDS send | Done |
| Settings → AMDS sending domains (proxy `/v1/domains`) | Done |
| Case email timeline delivery badges | Done |
| E2E bounce validation | `LiteDesk/server/scripts/validate-amds-track3-bounce.js` |

```bash
cd AMDS && npm run docker:up && npm run dev
cd LiteDesk/server && npm run dev
cd LiteDesk/server && node scripts/validate-amds-track3-bounce.js
```

See [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md) · [LITEDESK-TRACK-3-DRAFT.md](./LITEDESK-TRACK-3-DRAFT.md).

---

## Next: Track 4

Campaign queue, open/click tracking, analytics API.

**Last updated:** June 30, 2026
