# Track 2 — Production Delivery Engine (Local)

**Status:** Complete (June 2026)  
**Scope:** Retry queue, dead letter, webhook retries, rate limits, message events, direct SMTP module (OCI-ready). All validated against Mailpit on localhost.

See [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md)

---

## AMDS deliverables

| Item | Status |
|------|--------|
| Migration `002_track2.sql` — `message_events`, `dead_letter_messages`, `webhook_outbox` | Done |
| Versioned migration runner (`schema_migrations`) | Done |
| Direct SMTP transport (`SMTP_MODE=direct`, MX lookup + port 25) | Done |
| SMTP retry queue (BullMQ, soft vs hard error classification) | Done |
| Dead letter queue (`status: dead_letter`, `dead_letter_messages` table) | Done |
| Webhook delivery retries (`amds-webhook` queue + outbox) | Done |
| Per-tenant rate limiting (`429` on `POST /v1/messages`) | Done |
| Message events timeline on `GET /v1/messages/:id` | Done |
| Structured JSON logging (`message_id`, `tenant_id`, `event`) | Done |
| Config: `SMTP_MAX_ATTEMPTS`, `RATE_LIMIT_*`, `WEBHOOK_*` | Done — see `.env.example` |
| Automated validation | Done — `npm run validate:track-2` |
| CI (Phase 0a + Track 2 validation) | Done — `.github/workflows/ci.yml` |

---

## New env vars (Track 2)

```bash
SMTP_MODE=mailpit              # use direct on OCI
SMTP_MAX_ATTEMPTS=6
SMTP_RETRY_DELAY_MS=5000
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_SEC=60
WEBHOOK_MAX_ATTEMPTS=15
WEBHOOK_RETRY_DELAY_MS=60000
```

---

## API changes

### `POST /v1/messages`

| Status | Meaning |
|--------|---------|
| `429 Too Many Requests` | Per-tenant rate limit exceeded (`Retry-After: 60`) |

### `GET /v1/messages/:id`

Response now includes:

- `events[]` — append-only timeline (`queued`, `processing`, `delivery_attempt`, `delivered`, `failed`, `dead_letter`, `webhook_*`)
- `dead_letter` — `{ failure_reason, attempt_count, moved_at }` or `null`

**Status values:** `queued` · `processing` · `delivered` · `failed` · `dead_letter`

---

## Validate locally

**Prerequisites:** Track 1 running (`npm run dev`), migration 002 applied.

```bash
npm run docker:up
npm run db:migrate
npm run dev
```

**Full Track 2 validation** (includes webhook retry test):

```bash
# Worker must post webhooks to the validation mock (port 3999)
LITEDESK_WEBHOOK_URL=http://localhost:3999/api/internal/webhooks/amds npm run dev

# Separate terminal
npm run validate:track-2
```

Expected output ends with:

```text
Track 2 (AMDS local) — PASSED
```

For daily dev, keep `LITEDESK_WEBHOOK_URL=http://localhost:3000/...` (LiteDesk). The webhook retry check is skipped unless the worker targets port `3999`.

---

## Exit criteria met

```text
Send → retry on soft SMTP fail → deliver
     → dead_letter on hard SMTP fail
     → webhook retry on LiteDesk unreachable → deliver
     → 429 when tenant exceeds rate limit
     → events[] on GET /v1/messages/:id
```

All on localhost via Mailpit. **Next: Track 3** — domain auth, DKIM, suppressions, scheduling, bounce simulation.

---

## LiteDesk impact (Track 2)

No LiteDesk code changes required. Existing integration continues to work.

| Topic | LiteDesk action |
|-------|-----------------|
| `429` from AMDS | Back off and retry send (same as `5xx`) |
| Webhook retries | AMDS retries delivery for up to ~72h; poll fallback still valid |
| `GET /v1/messages/:id` | Optional — use `events[]` for richer delivery UI (Track 3+) |
| `message.failed` webhook | Fires on permanent SMTP failure or dead letter |

See [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md) for updated API notes.
