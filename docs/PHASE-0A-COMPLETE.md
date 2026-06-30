# Phase 0a — Local Exit Criteria

**Status:** Complete (June 2026)  
**Scope:** AMDS gateway + worker on localhost; LiteDesk CRM outbound via AMDS → Mailpit.

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Monorepo (`gateway`, `worker`, `shared`) | Done |
| `docker compose up` — Postgres, Redis, Mailpit | Done |
| `GET /health`, `GET /ready` | Done |
| PostgreSQL schema v1 + migrations | Done |
| `POST /v1/messages` → `202` | Done |
| `GET /v1/messages/:id` | Done |
| API key auth | Done |
| Idempotency by `idempotency_key` | Done |
| Worker → Mailpit SMTP (`localhost:1025`) | Done |
| Webhooks `message.delivered` / `message.failed` | Done |
| Webhook failure does not revert SMTP delivery | Done |
| Automated validation script | `npm run validate:phase-0a` |
| CI (build + Phase 0a validation) | `.github/workflows/ci.yml` |

---

## LiteDesk deliverables (separate repo)

| Item | Status |
|------|--------|
| `AmdsClient` + env config | Done |
| Webhook route + HMAC verification | Done |
| `amds_webhook_events` idempotency store | Done |
| CRM + case outbound via AMDS | Done |
| Settings → Integrations → Email → AMDS provider | Done |
| Webhook updates Communication + Case activity | Done |
| Case timeline + threads expose `deliveryStatus` | Done |
| Delivery poll fallback `GET /api/communications/:id/delivery-status` | Done |
| `sendCaseReplyEmail.js` (helpdesk contract) | Done |

---

## Validate locally

**Terminal 1 — infrastructure**

```bash
npm run docker:up
npm run db:migrate
```

**Terminal 2 — AMDS**

```bash
npm run dev
```

**Terminal 3 — validation**

```bash
npm run validate:phase-0a
```

Expected output ends with:

```text
Phase 0a (AMDS local) — PASSED
```

**Terminal 4 — LiteDesk (manual E2E)**

1. LiteDesk `.env`: `AMDS_BASE_URL`, `AMDS_API_KEY`, `AMDS_WEBHOOK_SECRET`
2. Settings → Integrations → Email → **AMDS**
3. Send email from People or Cases
4. Confirm Mailpit: http://localhost:8025
5. Confirm Communication: `metadata.amdsMessageId` set, `status: delivered`

---

## Exit criteria met

```text
LiteDesk send → AMDS POST /v1/messages → Worker → Mailpit → webhook → delivered
```

All on localhost. Track 1 complete.

---

## Next: Tracks 2–4 (local), then OCI

Strategy **Option A** — build everything on localhost with Mailpit; deploy to OCI once all tracks pass. No third-party SMTP providers.

See [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md):

- **Track 2** — retry queue, webhook retries, rate limits, message events
- **Track 3** — domain auth, DKIM, bounces, scheduling
- **Track 4** — campaigns, tracking, analytics
- **OCI deploy** — single cutover + first real inbox test (port 25)
