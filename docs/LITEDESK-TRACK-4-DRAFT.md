# LiteDesk Track 4 — Implementation Draft

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 4 complete — see [TRACK-4-COMPLETE.md](./TRACK-4-COMPLETE.md)  
**Prerequisite:** Tracks 1–3 done (`AmdsClient`, webhooks, Communication model, domains, bounces)

This document is a **copy-paste-ready draft** for the LiteDesk repo. Paths follow the layout in [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md).

---

## 1. Files to add or modify

| File | Action |
|------|--------|
| `server/services/amds/amds-types.ts` | Extend types — campaigns, analytics, engagement webhooks |
| `server/services/amds/amds-client.ts` | Add `sendCampaignBatch`, `getAnalyticsSummary` |
| `server/services/amds/handlers/communication-event-handler.ts` | Handle `message.opened`, `message.clicked` |
| `server/services/amds/handlers/campaign-stats-handler.ts` | **New** — aggregate opens/clicks on Campaign |
| `server/services/marketing/send-campaign-batch.js` | **New** — chunk recipients → AMDS batch API |
| `server/routes/internal/amds-webhook.ts` | Route engagement events |
| `server/routes/marketing/campaign-analytics.ts` | **New** — proxy `GET /v1/analytics/summary` |
| `server/models/campaign.js` | Add delivery + engagement stats fields |
| `server/models/communication.js` | Allow `opened` / `clicked` engagement metadata |
| `client/src/views/marketing/CampaignDetail.vue` | Stats cards + funnel (optional Phase 1 UI) |
| `server/scripts/validate-amds-track4-campaign.js` | **New** — E2E campaign + tracking test |

---

## 2. Types — `amds-types.ts`

Add/update these exports (merge with existing Track 3 file):

```typescript
// server/services/amds/amds-types.ts

// --- Track 4: tracking on single send (optional) ---

export interface TrackingOptions {
  opens: boolean;
  clicks: boolean;
}

// Extend SendMessageRequest:
// tracking?: TrackingOptions;

// Extend SendMessageResponse queue union:
export type AmdsQueue = 'transaction' | 'campaign';

// --- Track 4: campaign batch ---

export interface CampaignBatchMessage {
  idempotency_key: string;
  to: AmdsAddress[]; // AMDS accepts max 1 recipient per batch item
  subject: string;
  content: { html?: string; text?: string };
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface CampaignBatchRequest {
  tenant_id: string;
  from: AmdsAddress;
  messages: CampaignBatchMessage[];
  tracking?: TrackingOptions;
  metadata?: Record<string, unknown>;
}

export interface CampaignBatchMessageResult {
  message_id: string;
  status: string;
  idempotency_key: string;
}

export interface CampaignBatchRejected {
  idempotency_key: string;
  reason: string;
  detail?: unknown;
}

export interface CampaignBatchResponse {
  campaign_id: string;
  campaign_uuid: string;
  accepted: number;
  rejected: number;
  messages: CampaignBatchMessageResult[];
  errors: CampaignBatchRejected[];
}

// --- Track 4: analytics ---

export interface AnalyticsSummaryQuery {
  tenant_id: string;
  campaign_id?: string;
  from?: string;
  to?: string;
}

export interface AnalyticsSummaryResponse {
  tenant_id: string;
  campaign_id: string | null;
  period: { from: string | null; to: string | null };
  counts: {
    total: number;
    queued: number;
    scheduled: number;
    processing: number;
    delivered: number;
    failed: number;
    bounced: number;
    dead_letter: number;
    unique_opens: number;
    unique_clicks: number;
    total_opens: number;
    total_clicks: number;
  };
  rates: {
    delivery_rate: number;
    open_rate: number;
    click_rate: number;
  };
}

// --- Webhooks (extend existing) ---

export type AmdsWebhookEventType =
  | 'message.delivered'
  | 'message.failed'
  | 'message.bounced'
  | 'message.complained'
  | 'message.opened'   // Track 4
  | 'message.clicked'; // Track 4

export interface AmdsWebhookEvent {
  event_id: string;
  event_type: AmdsWebhookEventType;
  timestamp: string;
  tenant_id: string;
  message_id: string;
  metadata?: {
    litedesk_module?: string;
    litedesk_entity_id?: string;
    litedesk_communication_id?: string;
    litedesk_recipient_id?: string;
    campaign_external_id?: string;
    [key: string]: unknown;
  };
  delivery?: {
    recipient: string;
    smtp_response?: string;
    attempt: number;
    error?: string;
  };
  bounce?: {
    recipient: string;
    classification: 'hard' | 'soft';
    diagnostic: string;
    status_code: string | null;
  };
  engagement?: {
    recipient?: string;
    url?: string;
    hit_count: number;
  };
}
```

**Notes:**

- AMDS fires `message.opened` / `message.clicked` on **first hit only** per token (subsequent opens/clicks update AMDS analytics but do not re-webhook).
- `campaign_id` in the batch URL is LiteDesk's campaign ID (Mongo `_id` or slug). AMDS stores it as `external_id` — use the same string in analytics queries.

---

## 3. Client — `amds-client.ts`

Add methods below existing Track 3 methods. Keep retry pattern for batch sends (429 / 5xx).

```typescript
// server/services/amds/amds-client.ts — additions

import type {
  CampaignBatchRequest,
  CampaignBatchResponse,
  AnalyticsSummaryResponse,
} from './amds-types.js';

const CAMPAIGN_BATCH_MAX = 500; // AMDS limit per request

export class AmdsClient {
  // ... existing methods ...

  /**
   * Send a campaign batch. Splits into chunks of 500 if needed.
   * Uses the same idempotency keys per recipient — safe to retry whole chunk.
   */
  async sendCampaignBatch(
    campaignId: string,
    params: CampaignBatchRequest
  ): Promise<CampaignBatchResponse[]> {
    const chunks = chunkArray(params.messages, CAMPAIGN_BATCH_MAX);
    const results: CampaignBatchResponse[] = [];

    for (const messages of chunks) {
      const body = { ...params, messages };
      const data = await this.postWithRetry<CampaignBatchResponse>(
        `/v1/campaigns/${encodeURIComponent(campaignId)}/messages`,
        body
      );
      results.push(data);
    }

    return results;
  }

  async getAnalyticsSummary(
    query: AnalyticsSummaryQuery
  ): Promise<AnalyticsSummaryResponse> {
    const { data } = await this.http.get<AnalyticsSummaryResponse>(
      '/v1/analytics/summary',
      { params: query }
    );
    return data;
  }

  private async postWithRetry<T>(url: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const { data } = await this.http.post<T>(url, body);
        return data;
      } catch (err) {
        lastError = err;
        if (
          err instanceof AmdsApiError &&
          err.isRetryable &&
          attempt < MAX_SEND_ATTEMPTS - 1
        ) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
          continue;
        }
        throw this.wrapError(err);
      }
    }
    throw lastError;
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
```

**Single transactional send with tracking (optional):**

```typescript
await amdsClient.sendMessageWithRetry({
  // ...existing fields...
  tracking: { opens: true, clicks: true }, // Track 4 — for tracked CRM emails if desired
});
```

---

## 4. Campaign send service — `send-campaign-batch.js`

LiteDesk renders HTML locally (merge tags, unsubscribe link) **before** calling AMDS. AMDS wraps links and injects the open pixel when `tracking.clicks` / `tracking.opens` are true.

```javascript
// server/services/marketing/send-campaign-batch.js

const { amdsClient } = require('../../config/amds');
const { AmdsApiError } = require('../amds/amds-errors');
const { CampaignModel } = require('../../models/campaign');
const { CommunicationModel } = require('../../models/communication');

const BATCH_SIZE = 500;

/**
 * @param {object} params
 * @param {string} params.orgId
 * @param {import('mongoose').Types.ObjectId} params.campaignId
 * @param {{ email: string; name?: string; recipientId: string }[]} params.recipients
 * @param {{ email: string; name?: string }} params.from
 * @param {string} params.subject
 * @param {{ html: string; text?: string }} params.content — pre-rendered per campaign or per recipient
 * @param {boolean} [params.trackOpens=true]
 * @param {boolean} [params.trackClicks=true]
 */
async function sendCampaignBatch({
  orgId,
  campaignId,
  recipients,
  from,
  subject,
  content,
  trackOpens = true,
  trackClicks = true,
}) {
  const campaign = await CampaignModel.findOne({ _id: campaignId, orgId });
  if (!campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.status === 'sent' || campaign.status === 'sending') {
    throw new Error('Campaign already sent or in progress');
  }

  await CampaignModel.updateOne(
    { _id: campaignId },
    { $set: { status: 'sending', 'stats.sendStartedAt': new Date() } }
  );

  const externalCampaignId = String(campaignId);
  const messages = [];
  const communications = [];

  for (const recipient of recipients) {
    const communication = await CommunicationModel.create({
      orgId,
      moduleKey: 'marketing',
      entityId: String(campaignId),
      channel: 'email',
      direction: 'outbound',
      toEmail: recipient.email,
      toName: recipient.name,
      fromEmail: from.email,
      subject,
      status: 'pending',
      metadata: {
        campaignId: externalCampaignId,
        recipientId: recipient.recipientId,
      },
    });

    communications.push(communication);

    messages.push({
      idempotency_key: `litedesk-marketing-${orgId}-${campaignId}-${recipient.recipientId}`,
      to: [{ email: recipient.email, name: recipient.name }],
      subject,
      content,
      metadata: {
        litedesk_module: 'marketing',
        litedesk_entity_id: externalCampaignId,
        litedesk_communication_id: String(communication._id),
        litedesk_recipient_id: recipient.recipientId,
        campaign_external_id: externalCampaignId,
      },
      tags: ['marketing', 'campaign'],
    });
  }

  try {
    const batchResults = await amdsClient.sendCampaignBatch(externalCampaignId, {
      tenant_id: orgId,
      from,
      tracking: { opens: trackOpens, clicks: trackClicks },
      metadata: {
        litedesk_module: 'marketing',
        litedesk_entity_id: externalCampaignId,
      },
      messages,
    });

    let accepted = 0;
    let rejected = 0;
    const rejectedKeys = new Set(
      batchResults.flatMap((r) => r.errors.map((e) => e.idempotency_key))
    );

    for (const result of batchResults) {
      accepted += result.accepted;
      rejected += result.rejected;
    }

    // Map message_id back to Communication records
    const resultByKey = new Map(
      batchResults.flatMap((r) => r.messages.map((m) => [m.idempotency_key, m]))
    );

    for (const communication of communications) {
      const key = `litedesk-marketing-${orgId}-${campaignId}-${communication.metadata.recipientId}`;
      const amdsResult = resultByKey.get(key);

      if (rejectedKeys.has(key)) {
        await CommunicationModel.updateOne(
          { _id: communication._id },
          {
            $set: {
              status: 'failed',
              'metadata.sendError': 'suppressed_or_rejected',
            },
          }
        );
        continue;
      }

      if (amdsResult) {
        await CommunicationModel.updateOne(
          { _id: communication._id },
          {
            $set: {
              status: 'queued',
              'metadata.amdsMessageId': amdsResult.message_id,
              'metadata.amdsQueue': 'campaign',
            },
          }
        );
      }
    }

    await CampaignModel.updateOne(
      { _id: campaignId },
      {
        $set: {
          status: 'sent',
          'stats.sendCompletedAt': new Date(),
          'stats.queued': accepted,
          'stats.rejected': rejected,
          'stats.totalRecipients': recipients.length,
        },
      }
    );

    return { accepted, rejected, batchResults };
  } catch (err) {
    await CampaignModel.updateOne(
      { _id: campaignId },
      { $set: { status: 'failed', 'stats.sendError': err.message } }
    );

    if (err instanceof AmdsApiError && err.isDomainNotVerified) {
      throw userFacingError(
        `Sending domain not verified: ${err.body.domain}. Verify DNS in Settings → Email.`
      );
    }
    throw err;
  }
}

module.exports = { sendCampaignBatch };
```

**Route wiring (sketch):**

```javascript
// server/routes/marketing/campaigns.js — POST /api/marketing/campaigns/:id/send

router.post('/:id/send', requireAuth, async (req, res, next) => {
  try {
    const result = await sendCampaignBatch({
      orgId: req.user.orgId,
      campaignId: req.params.id,
      recipients: req.body.recipients, // or load from segment
      from: req.body.from,
      subject: req.body.subject,
      content: req.body.content,
    });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});
```

---

## 5. Webhook handler — engagement events

Extend `communication-event-handler.ts` (Track 3) with open/click cases. Delegate campaign-level aggregation to `campaign-stats-handler.ts`.

```typescript
// server/services/amds/handlers/communication-event-handler.ts — add cases

import { incrementCampaignEngagement } from './campaign-stats-handler.js';

export async function processCommunicationEvent(event: AmdsWebhookEvent): Promise<void> {
  const communication = await findCommunication(event);
  if (!communication) {
    return;
  }

  switch (event.event_type) {
    // ... existing delivered / failed / bounced cases ...

    case 'message.opened':
      await updateCommunication(communication._id, {
        'metadata.openedAt': new Date(event.timestamp),
        'metadata.openCount': event.engagement?.hit_count ?? 1,
        'metadata.lastAmdsEvent': event.event_type,
      });
      if (event.metadata?.litedesk_module === 'marketing') {
        await incrementCampaignEngagement({
          campaignId: event.metadata.litedesk_entity_id,
          type: 'open',
          recipient: event.engagement?.recipient,
        });
      }
      break;

    case 'message.clicked':
      await updateCommunication(communication._id, {
        'metadata.clickedAt': new Date(event.timestamp),
        'metadata.clickedUrl': event.engagement?.url ?? null,
        'metadata.clickCount': event.engagement?.hit_count ?? 1,
        'metadata.lastAmdsEvent': event.event_type,
      });
      if (event.metadata?.litedesk_module === 'marketing') {
        await incrementCampaignEngagement({
          campaignId: event.metadata.litedesk_entity_id,
          type: 'click',
          recipient: event.engagement?.recipient,
          url: event.engagement?.url,
        });
      }
      break;

    default:
      break;
  }

  // Keep existing case activity append for delivery events;
  // optionally skip activity noise for opens/clicks or add lightweight entries.
}
```

```typescript
// server/services/amds/handlers/campaign-stats-handler.ts

import { CampaignModel } from '../../models/campaign.js';

export async function incrementCampaignEngagement(params: {
  campaignId: string | undefined;
  type: 'open' | 'click';
  recipient?: string;
  url?: string;
}): Promise<void> {
  if (!params.campaignId) return;

  const incField =
    params.type === 'open' ? 'stats.uniqueOpens' : 'stats.uniqueClicks';

  await CampaignModel.updateOne(
    { _id: params.campaignId },
    {
      $inc: { [incField]: 1 },
      $set: { 'stats.lastEngagementAt': new Date() },
    }
  );
}

/** Reconcile from AMDS analytics API (poll fallback / dashboard refresh) */
export async function syncCampaignStatsFromAmds(
  orgId: string,
  campaignId: string
): Promise<void> {
  const summary = await amdsClient.getAnalyticsSummary({
    tenant_id: orgId,
    campaign_id: campaignId,
  });

  await CampaignModel.updateOne(
    { _id: campaignId, orgId },
    {
      $set: {
        'stats.delivered': summary.counts.delivered,
        'stats.failed': summary.counts.failed + summary.counts.dead_letter,
        'stats.bounced': summary.counts.bounced,
        'stats.uniqueOpens': summary.counts.unique_opens,
        'stats.uniqueClicks': summary.counts.unique_clicks,
        'stats.totalOpens': summary.counts.total_opens,
        'stats.totalClicks': summary.counts.total_clicks,
        'stats.deliveryRate': summary.rates.delivery_rate,
        'stats.openRate': summary.rates.open_rate,
        'stats.clickRate': summary.rates.click_rate,
        'stats.syncedAt': new Date(),
      },
    }
  );
}
```

**Delivery events for campaign sends:** existing `message.delivered` / `message.failed` / `message.bounced` handlers already update Communication — extend campaign stats:

```typescript
case 'message.delivered':
  // ... existing communication update ...
  if (event.metadata?.litedesk_module === 'marketing') {
    await CampaignModel.updateOne(
      { _id: event.metadata.litedesk_entity_id },
      { $inc: { 'stats.delivered': 1 } }
    );
  }
  break;
```

---

## 6. Analytics proxy route

Vue never calls AMDS directly. LiteDesk proxies analytics for org admins.

```typescript
// server/routes/marketing/campaign-analytics.ts

import { Router } from 'express';
import { requireAuth, requireOrgAdmin } from '../../middleware/auth.js';
import { amdsClient } from '../../config/amds.js';
import { syncCampaignStatsFromAmds } from '../../services/amds/handlers/campaign-stats-handler.js';

const router = Router();

/** GET /api/marketing/campaigns/:id/analytics */
router.get('/:id/analytics', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.user.orgId;
    const campaignId = req.params.id;
    const { from, to } = req.query;

    const summary = await amdsClient.getAnalyticsSummary({
      tenant_id: orgId,
      campaign_id: campaignId,
      from: from as string | undefined,
      to: to as string | undefined,
    });

    // Optional: persist snapshot on Campaign for offline dashboard
    await syncCampaignStatsFromAmds(orgId, campaignId);

    res.json(summary);
  } catch (err) {
    next(err);
  }
});

export default router;
```

Register under marketing routes:

```javascript
app.use('/api/marketing/campaigns', campaignAnalyticsRouter);
```

---

## 7. Campaign model fields

Extend `Campaign` schema (adjust to your existing Marketing model):

```javascript
// server/models/campaign.js

status: {
  type: String,
  enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'],
  default: 'draft',
},

stats: {
  totalRecipients: { type: Number, default: 0 },
  queued: { type: Number, default: 0 },
  delivered: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  bounced: { type: Number, default: 0 },
  rejected: { type: Number, default: 0 },
  uniqueOpens: { type: Number, default: 0 },
  uniqueClicks: { type: Number, default: 0 },
  totalOpens: { type: Number, default: 0 },
  totalClicks: { type: Number, default: 0 },
  deliveryRate: { type: Number, default: 0 },
  openRate: { type: Number, default: 0 },
  clickRate: { type: Number, default: 0 },
  sendStartedAt: Date,
  sendCompletedAt: Date,
  lastEngagementAt: Date,
  syncedAt: Date,
  sendError: String,
},
```

**Communication metadata (per recipient):**

```javascript
metadata: {
  amdsMessageId: String,
  amdsQueue: String,           // 'campaign'
  campaignId: String,
  recipientId: String,
  openedAt: Date,
  openCount: Number,
  clickedAt: Date,
  clickedUrl: String,
  clickCount: Number,
}
```

---

## 8. Vue 3 — Campaign detail stats (sketch)

**Route:** `/marketing/campaigns/:id`

```vue
<!-- client/src/views/marketing/CampaignDetail.vue — stats section -->

<template>
  <div class="campaign-stats grid grid-cols-4 gap-4">
    <StatCard label="Sent" :value="stats.delivered" />
    <StatCard label="Open rate" :value="formatPct(stats.openRate)" />
    <StatCard label="Click rate" :value="formatPct(stats.clickRate)" />
    <StatCard label="Bounced" :value="stats.bounced" />
  </div>
  <button @click="refreshAnalytics">Refresh stats</button>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '@/services/api';

const props = defineProps({ campaignId: String });
const stats = ref({});

async function refreshAnalytics() {
  const { data } = await api.get(`/marketing/campaigns/${props.campaignId}/analytics`);
  stats.value = {
    delivered: data.counts.delivered,
    openRate: data.rates.open_rate,
    clickRate: data.rates.click_rate,
    bounced: data.counts.bounced,
  };
}

onMounted(refreshAnalytics);
</script>
```

**Recipient list:** show per-Communication `openedAt` / `clickedAt` badges (same pattern as case timeline delivery badges from Track 3).

---

## 9. Webhook route — no structural change

`POST /api/internal/webhooks/amds` already verifies HMAC and dedupes on `event_id`. Ensure `processCommunicationEvent` handles the new event types (section 5).

**Idempotency:** AMDS sends at most one `message.opened` and one `message.clicked` webhook per message (first hit). Replays of the same `event_id` must remain no-ops (existing `amds_webhook_events` index).

---

## 10. Local test procedure

**Terminal 1 — AMDS**

```bash
cd AMDS
npm run docker:up && npm run db:migrate
LITEDESK_WEBHOOK_URL=http://localhost:3000/api/internal/webhooks/amds npm run dev
npm run validate:track-4   # AMDS-only sanity check
```

**Terminal 2 — LiteDesk**

```bash
cd LiteDesk/server && npm run dev
```

**Manual E2E**

1. Settings → Email → AMDS — verify sending domain (`localhost.test` with `DNS_VERIFY_BYPASS=true` on AMDS).
2. Marketing → create campaign with HTML body containing `<a href="https://example.com">CTA</a>`.
3. Add 2 test recipients → Send.
4. Mailpit (http://localhost:8025) — confirm 2 emails with `/t/` pixel and `/c/` wrapped links.
5. Open pixel URL or click link in email HTML source.
6. Campaign detail — stats show ≥1 open / click (webhook path) or click Refresh (analytics API path).
7. Communication records → `metadata.openedAt` / `clickedAt` populated.

**Automated E2E script** — `server/scripts/validate-amds-track4-campaign.js`:

```javascript
#!/usr/bin/env node
/**
 * LiteDesk Track 4 E2E — requires AMDS gateway+worker and LiteDesk server running.
 *
 * Flow:
 * 1. Create test campaign + 2 recipients via LiteDesk API (or direct service call)
 * 2. POST send → AMDS batch
 * 3. Poll Mailpit / communications until delivered
 * 4. Hit tracking URLs extracted from Mailpit HTML
 * 5. Assert campaign analytics + webhook events
 */

const BASE = process.env.LITEDESK_API_URL || 'http://localhost:3000';
const AMDS_MAILPIT = process.env.MAILPIT_API_URL || 'http://localhost:8025';

async function main() {
  // Implement using your auth token helper + campaign API
  // Mirror AMDS validate-track-4.js Mailpit parsing for open/click tokens
  console.log('LiteDesk Track 4 — implement against your campaign send API');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

---

## 11. Implementation checklist

```
[ ] amds-types — campaign batch, analytics, engagement webhook types
[ ] amds-client — sendCampaignBatch (chunked), getAnalyticsSummary
[ ] send-campaign-batch.js — recipients → Communications → AMDS batch
[ ] communicationEventHandler — message.opened / message.clicked
[ ] campaign-stats-handler — increment + syncCampaignStatsFromAmds
[ ] delivery webhooks — increment campaign.stats.delivered / bounced
[ ] Campaign model — stats fields + status enum
[ ] POST /api/marketing/campaigns/:id/send
[ ] GET /api/marketing/campaigns/:id/analytics (proxy AMDS)
[ ] Vue — campaign stats cards + recipient engagement badges
[ ] validate-amds-track4-campaign.js
[ ] Manual Mailpit E2E (2 recipients, open + click)
```

---

## 12. Explicitly out of scope (LiteDesk)

| Item | Owner |
|------|--------|
| Open/click pixel + redirect endpoints (`/t/`, `/c/`) | AMDS (public, no auth) |
| HTML link wrapping + pixel injection | AMDS worker at SMTP send time |
| Campaign queue / bulk throughput tuning | AMDS |
| `TRACKING_BASE_URL` DNS (`track.customer.com`) | AMDS + OCI deploy (Track 5) |
| AMDS template rendering (`template_id`) | Future |
| `message.complained` | Future |
| A/B test splits, send-time optimization | LiteDesk product (future) |

---

## 13. Production notes

| Topic | Guidance |
|-------|----------|
| **Batch size** | Max 500 recipients per AMDS request — chunk in `sendCampaignBatch` |
| **Idempotency** | Key format `litedesk-marketing-{orgId}-{campaignId}-{recipientId}` — safe to retry failed chunks |
| **Rate limits** | AMDS `429` on burst — backoff between chunks for large lists |
| **Stats source of truth** | Webhooks for real-time UI; `GET /v1/analytics/summary` for reconciliation |
| **Tracking URLs** | Local: `http://localhost:8080/t/...`; prod: `https://track.yourdomain.com/t/...` (AMDS `TRACKING_BASE_URL`) |
| **Unsubscribe links** | LiteDesk renders into HTML **before** AMDS send — AMDS click tracking wraps them like any other link |

---

## 14. AMDS API quick reference

| Method | AMDS path | LiteDesk usage |
|--------|-----------|----------------|
| POST | `/v1/campaigns/:id/messages` | Bulk campaign send |
| GET | `/v1/analytics/summary` | Campaign dashboard / sync |
| POST | `/v1/messages` + `tracking` | Optional tracked transactional email |
| — | Webhook `message.opened` | Update Communication + Campaign stats |
| — | Webhook `message.clicked` | Update Communication + Campaign stats |

Full AMDS contract: [TRACK-4-COMPLETE.md](./TRACK-4-COMPLETE.md) · [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

---

*Maintained in AMDS repo at `docs/LITEDESK-TRACK-4-DRAFT.md`. Copy into LiteDesk repo or link from LiteDesk integration docs.*

**Last updated:** June 30, 2026
