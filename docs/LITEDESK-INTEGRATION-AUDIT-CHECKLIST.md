# LiteDesk ↔ AMDS Integration Audit Checklist

**Audience:** LiteDesk developers verifying integration against AMDS  
**Use:** Run through your LiteDesk repo and mark each item **Done** / **Partial** / **Missing**  
**Related:** [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md) · Track 4 [LITEDESK-TRACK-4-DRAFT.md](./LITEDESK-TRACK-4-DRAFT.md) · Track 6 phases [LITEDESK-TRACK-6-PHASE1-DRAFT.md](./LITEDESK-TRACK-6-PHASE1-DRAFT.md) through [PHASE5](./LITEDESK-TRACK-6-PHASE5-DRAFT.md)

---

## How to use

1. Clone/open the **LiteDesk** repo (not AMDS).
2. Walk sections **A → H** in order; skip sections already known to be out of scope.
3. For each checkbox, grep the codebase, trace a manual send, or hit the verification curl in **Section I**.
4. Record **Done / Partial / Missing** in your PR or internal tracker.
5. Use **Section J** to prioritize remaining work.

**Note:** Track 4 (campaigns) and Track 6 (policies, reputation, throughput) are **layers**. A completed Track 4 does not need to be reimplemented — extend it with Track 6 items below.

---

## A. Foundation (Tracks 1–3) — prerequisite

### Config & client

- [ ] `AMDS_BASE_URL`, `AMDS_API_KEY`, webhook signing secret in env
- [ ] `AmdsClient` singleton with Bearer auth on outbound calls
- [ ] `tenant_id` = stable org identifier on every AMDS call (same value as policy sync)

### Transactional send (helpdesk)

- [ ] `POST /v1/messages` from case reply flow
- [ ] Idempotency key per send (no duplicate sends on retry)
- [ ] Handles `202` + stores `message_id` on Communication
- [ ] Poll fallback: `GET /v1/messages/:id` if webhook delayed

### Webhooks (message events)

- [ ] Route: `POST /api/internal/webhooks/amds` (or equivalent)
- [ ] HMAC verification with shared secret
- [ ] Idempotency on `event_id` (no double-processing)
- [ ] `message.delivered` → Communication status updated
- [ ] `message.failed` → Communication status updated
- [ ] `message.bounced` → Communication + suppression/contact handling
- [ ] `message.complained` → handled (even if UI is minimal)

### Domains & bounces (Track 3)

- [ ] Domain CRUD proxies `GET/POST /v1/domains`, verify endpoint
- [ ] Settings UI for SPF/DKIM/DMARC status
- [ ] Hard bounce suppresses contact / shows agent alert

---

## B. Track 4 — Campaigns

### AMDS client & types

- [ ] `sendCampaignBatch(campaignId, body)` → `POST /v1/campaigns/:id/messages`
- [ ] Batch respects **1 recipient per message** in batch items
- [ ] `tracking: { opens, clicks }` passed when enabled
- [ ] `metadata` includes `litedesk_module`, `litedesk_entity_id`, campaign id
- [ ] `getAnalyticsSummary({ tenant_id, campaign_id?, from?, to? })` → `GET /v1/analytics/summary`

### Send pipeline

- [ ] Recipients chunked (≤500 per AMDS batch)
- [ ] Idempotency key per recipient (stable across retries)
- [ ] Suppressed contacts skipped before AMDS call (or rejected rows handled)
- [ ] Accepted/rejected counts stored on Campaign
- [ ] `campaign_id` in URL = LiteDesk campaign id (AMDS `external_id`)

### Engagement webhooks

- [ ] `message.opened` → Campaign/Communication stats updated
- [ ] `message.clicked` → Campaign/Communication stats updated
- [ ] Events matched via `metadata.litedesk_entity_id` or `campaign_external_id`

### Campaign UI

- [ ] Campaign detail shows: sent, delivered, bounced, failed
- [ ] Campaign detail shows: unique opens, unique clicks, rates
- [ ] Optional: funnel / stats cards from analytics proxy route

### Track 4 E2E

- [ ] Send test campaign → messages reach Mailpit/OCI
- [ ] Open pixel + click link → webhooks received in LiteDesk
- [ ] Analytics API returns non-zero opens/clicks after engagement

---

## C. Track 6 Phase 1 — Policies & credits

### Policy sync (LiteDesk → AMDS)

- [ ] Model: org email policy (credits, limits, status, flags)
- [ ] `PUT /v1/tenants/:id/policy` on: org create, limit change, credit purchase, suspend/activate
- [ ] `PATCH /v1/tenants/:id/credits` when credits added
- [ ] `POST .../suspend` / `.../activate` when org email disabled/enabled
- [ ] Fields synced: `monthly_credits`, `credits_remaining`, `daily_send_limit`, `max_hourly_rate`, `burst_rate_per_min`, `max_campaign_size`, `warmup_enabled`, `reputation_enabled`, `status`

### Credit / limit webhooks (AMDS → LiteDesk)

- [ ] Handler: `credit.reserved`
- [ ] Handler: `credit.consumed`
- [ ] Handler: `credit.released`
- [ ] Handler: `policy.limit_exceeded`
- [ ] Org policy cache/UI updates from webhooks

### Send error handling (transactional + campaign)

- [ ] `402` + `insufficient_credits` → user-visible message
- [ ] `422` + `campaign_size_exceeded` → batch too large
- [ ] `429` + `daily_limit_exceeded` / `hourly_limit_exceeded` / `burst_limit_exceeded`
- [ ] `403` + `tenant_suspended`
- [ ] `403` + `policy_not_found` (when AMDS `TENANT_POLICIES_REQUIRED=true`)

### Settings UI

- [ ] Settings → Email shows credits remaining, daily/hourly limits
- [ ] Values match AMDS after sync (`GET /v1/tenants/:id/policy` in dev)

---

## D. Track 6 Phase 2 — Reputation

### Client & cache

- [ ] `getTenantReputation(tenantId)` → `GET /v1/tenants/:id/reputation`
- [ ] Optional: `getReputationHistory(tenantId)`

### Webhook

- [ ] Handler: `reputation.updated` (score, delta, factors)
- [ ] Cached score on org policy or dedicated model

### UI

- [ ] Settings → Email reputation card: score, delta, last updated
- [ ] Optional: history sparkline from history API

---

## E. Track 6 Phase 3 — Throughput & ETA

### Client

- [ ] `getTenantThroughput(tenantId)` → `GET /v1/tenants/:id/throughput`
- [ ] `getCampaignEstimate(tenantId, campaignId, recipientCount)` → `GET /v1/campaigns/:id/estimate`

### Webhook

- [ ] Handler: `throughput.updated`

### Campaign composer (extends Track 4)

- [ ] Pre-send: show **effective hourly rate** vs max rate
- [ ] Pre-send: show **estimated completion** for recipient count
- [ ] Pre-send: block marketing if reputation < 40 (local check; AMDS returns `403 marketing_restricted`)
- [ ] Handle `403 marketing_restricted` with clear user copy

### Settings UI

- [ ] Throughput card: multipliers (reputation, warm-up, infra), effective rate

---

## F. Track 6 Phase 4 — Campaign health & guidance

### Client

- [ ] `getCampaignHealth(campaignId, tenantId)` → `GET /v1/campaigns/:id/health`
- [ ] `getReputationGuidance(tenantId)` → `GET /v1/tenants/:id/reputation/guidance`

### Analytics types (extend Track 4 — backward compatible)

- [ ] `counts.complaints` parsed (optional field)
- [ ] `rates.complaint_rate`, `rates.hard_bounce_rate` parsed
- [ ] `reputation?: { score, previous_score, delta }` on summary
- [ ] `campaign_health?: { score, factors }` when `campaign_id` filter set

### UI

- [ ] Campaign detail: **campaign health** score (separate from tenant reputation)
- [ ] Campaign detail: health factors (bounce/complaint warnings)
- [ ] Settings: guidance panel — reasons (passed/warning/failed) + recommendations

---

## G. Track 6 Phase 5 — Infra & recovery (optional UX)

- [ ] Reputation response includes `recovery.day_start_score`, `recovery.remaining_gain_today`
- [ ] UI copy when `remaining_gain_today` is low (“recovery is gradual”)
- [ ] When `throughput.multipliers.infra < 1`, show “platform load — send rate temporarily reduced”
- [ ] Internal ops: awareness of `GET /v1/admin/infra/status` (no end-user UI required)

---

## H. Cross-cutting quality

### Metadata contract

- [ ] Every send includes consistent `tenant_id`
- [ ] Campaign sends include `litedesk_entity_id` = campaign id
- [ ] Transactional sends include case/ticket id in metadata where applicable

### Error typing

- [ ] `AmdsApiError` (or equivalent) maps AMDS `error` string to app errors
- [ ] Logs include AMDS status + body for 4xx/5xx (no secrets)

### Production readiness

- [ ] LiteDesk reachable from AMDS worker for webhooks (firewall / security list)
- [ ] AMDS `LITEDESK_WEBHOOK_URL` points to LiteDesk handler
- [ ] If `TENANT_POLICIES_REQUIRED=true` on AMDS: policy sync verified before send tests

---

## I. Quick verification commands (dev)

Run with LiteDesk + AMDS up (`npm run dev` in AMDS). Replace `ORG_ID` and `CAMPAIGN_ID`.

```bash
# Policy
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  http://localhost:8080/v1/tenants/ORG_ID/policy | jq

# Reputation + recovery
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  http://localhost:8080/v1/tenants/ORG_ID/reputation | jq

# Throughput
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  http://localhost:8080/v1/tenants/ORG_ID/throughput | jq

# Campaign analytics
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  "http://localhost:8080/v1/analytics/summary?tenant_id=ORG_ID&campaign_id=CAMPAIGN_ID" | jq

# Campaign health
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  "http://localhost:8080/v1/campaigns/CAMPAIGN_ID/health?tenant_id=ORG_ID" | jq

# Reputation guidance
curl -s -H "Authorization: Bearer $AMDS_API_KEY" \
  http://localhost:8080/v1/tenants/ORG_ID/reputation/guidance | jq
```

### AMDS-side regression (confirms AMDS while auditing LiteDesk)

From the AMDS repo:

```bash
npm run validate:track-4
npm run validate:track-6a   # policies/credits
npm run validate:track-6b   # reputation
npm run validate:track-6c   # throughput
npm run validate:track-6d   # campaign health
npm run validate:track-6e   # infra/recovery
```

---

## J. Scoring summary

| Section | Scope | Priority if missing |
|---------|--------|-------------------|
| **A** | Foundation (Tracks 1–3) | **Critical** — fix first |
| **B** | Track 4 campaigns | Verify if claimed done |
| **C** | Track 6 Phase 1 | **High** for production |
| **D** | Track 6 Phase 2 | Medium |
| **E** | Track 6 Phase 3 | Medium |
| **F** | Track 6 Phase 4 | Low–medium |
| **G** | Track 6 Phase 5 | Low (UX polish) |
| **H** | Cross-cutting | Ongoing |

### Minimum “confirmed” bars

**Track 4 only (local/dev):** **A** + **B** complete; Section **I** analytics/health curls pass after a test campaign.

**Production with Track 6:** above + **C** complete + **D/E** composer gates + **402/403/429** handling on all send paths.

---

## K. Result template (copy for your audit)

```markdown
## LiteDesk AMDS audit — YYYY-MM-DD

| Section | Status | Notes |
|---------|--------|-------|
| A Foundation | Done / Partial / Missing | |
| B Track 4 | Done / Partial / Missing | |
| C Phase 1 | Done / Partial / Missing | |
| D Phase 2 | Done / Partial / Missing | |
| E Phase 3 | Done / Partial / Missing | |
| F Phase 4 | Done / Partial / Missing | |
| G Phase 5 | Done / Partial / Missing | |
| H Cross-cutting | Done / Partial / Missing | |

### Top gaps
1.
2.
3.

### Next actions
1.
2.
```

---

*Last updated: July 2, 2026*
