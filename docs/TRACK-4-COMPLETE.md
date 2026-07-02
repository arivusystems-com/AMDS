# Track 4 — Campaigns, Tracking, Analytics (Local)

**Status:** Complete (AMDS side — June 2026)  
**Scope:** Campaign queue, batch ingest, open/click tracking, engagement webhooks, analytics API.

See [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [TRACK-3-COMPLETE.md](./TRACK-3-COMPLETE.md) · [LITEDESK-TRACK-4-DRAFT.md](./LITEDESK-TRACK-4-DRAFT.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `004_track4.sql` — `campaigns`, `tracking_tokens`, message tracking flags | Done |
| Campaign queue (`amds-campaign`) | Done |
| `POST /v1/campaigns/:id/messages` — batch ingest | Done |
| `GET /t/:token.png` — open pixel (no auth) | Done |
| `GET /c/:token` — click redirect (no auth) | Done |
| Webhooks `message.opened`, `message.clicked` | Done |
| `GET /v1/analytics/summary` | Done |
| Campaign worker concurrency (`CAMPAIGN_WORKER_CONCURRENCY`) | Done |
| `tracking` option on `POST /v1/messages` | Done |
| Automated validation | Done — `npm run validate:track-4` |
| CI | Done — `.github/workflows/ci.yml` |

---

## New env vars

```bash
TRACKING_BASE_URL=http://localhost:8080
CAMPAIGN_WORKER_CONCURRENCY=2
```

---

## API summary

### Campaign batch send

```bash
POST /v1/campaigns/{campaign_id}/messages
{
  "tenant_id": "org_abc",
  "from": { "email": "news@customer.com", "name": "Acme" },
  "tracking": { "opens": true, "clicks": true },
  "messages": [
    {
      "idempotency_key": "camp-1-user-1",
      "to": [{ "email": "user@example.com" }],
      "subject": "June newsletter",
      "content": {
        "html": "<html><body><a href=\"https://example.com\">Read more</a></body></html>",
        "text": "Read more at https://example.com"
      }
    }
  ]
}
```

Response: `202` with `accepted`, `rejected`, and per-message `message_id` list. Messages use `queue: campaign`.

### Analytics

```bash
GET /v1/analytics/summary?tenant_id=org_abc&campaign_id=camp_june&from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.000Z
```

Returns delivery counts, unique/total opens and clicks, and rates.

### Tracking (public, no API key)

- Open: `GET /t/{token}.png` → 1×1 PNG, records `opened` event
- Click: `GET /c/{token}` → 302 to original URL, records `clicked` event

First open/click per token dispatches webhook to LiteDesk.

---

## Validate locally

```bash
npm run db:migrate
LITEDESK_WEBHOOK_URL=http://127.0.0.1:3997/api/internal/webhooks/amds npm run dev
npm run validate:track-4
```

Expected: `Track 4 (AMDS local) — PASSED`

---

## LiteDesk (separate repo)

**Status:** Not started

| Item | Status |
|------|--------|
| Campaign batch send via AMDS client | Not started |
| Webhook `message.opened` / `message.clicked` | Not started |
| Marketing stats UI (analytics proxy) | Not started |

---

## Next: Track 5

Production hardening — multi-worker, metrics, Terraform, OCI deploy.

**Last updated:** June 30, 2026
