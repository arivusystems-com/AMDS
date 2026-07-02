# LiteDesk Track 6 Phase 1 — Tenant Policies & Credits

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 6 Phase 1 complete — see [TRACK-6-PHASE1-COMPLETE.md](./TRACK-6-PHASE1-COMPLETE.md)  
**Prerequisite:** Tracks 1–3 integration done; Track 4 recommended for campaign credit UX

This document is a **copy-paste-ready draft** for the LiteDesk repo. Build in parallel with AMDS Phase 1.

**Related:** [SENDER-REPUTATION-ROADMAP.md](./SENDER-REPUTATION-ROADMAP.md) · [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

---

## 1. Goal

LiteDesk remains the **source of truth** for tenant email entitlements. AMDS enforces them at send time.

LiteDesk must:

1. Store per-org email configuration (credits, limits, flags)
2. Sync configuration to AMDS whenever it changes
3. Handle AMDS credit/limit webhooks to keep UI accurate
4. Show credits and limits in Settings + campaign composer (basic Phase 1 UI)

Reputation and dynamic throughput come in **Phase 2–3** — stub the types now, implement UI later.

---

## 2. Files to add or modify

| File | Action |
|------|--------|
| `server/models/org-email-policy.js` | **New** — MongoDB schema |
| `server/services/amds/amds-types.ts` | Extend types |
| `server/services/amds/amds-client.ts` | Policy sync methods |
| `server/services/amds/amds-policy-sync.js` | **New** — push policy to AMDS |
| `server/services/amds/handlers/tenant-event-handler.ts` | **New** — credit/limit webhooks |
| `server/routes/internal/amds-webhook.ts` | Route new event types |
| `server/routes/settings/email-policy.js` | **New** — admin CRUD (org settings) |
| `server/services/billing/email-credits.js` | **New** — allocate on subscription/pack |
| `server/services/communications/sendCaseReplyEmail.js` | Handle 402 from AMDS |
| `server/services/marketing/sendCampaign.js` | Handle 402/422/429 (Track 4) |
| `client/src/views/settings/EmailPolicy.vue` | **New** — credits + limits display |
| `server/scripts/validate-amds-track6-phase1.js` | **New** — E2E sync test |

---

## 3. MongoDB model — `org-email-policy`

One document per organization (`orgId`).

```javascript
// server/models/org-email-policy.js
import mongoose from 'mongoose';

const orgEmailPolicySchema = new mongoose.Schema(
  {
    orgId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },

    // Entitlements (LiteDesk source of truth)
    monthlyCredits: { type: Number, default: 0, min: 0 },
    creditsRemaining: { type: Number, default: 0, min: 0 },

    // Operational limits (synced to AMDS)
    dailySendLimit: { type: Number, default: 0, min: 0 },       // 0 = unlimited
    maxHourlyRate: { type: Number, default: 0, min: 0 },
    burstRatePerMin: { type: Number, default: 0, min: 0 },
    maxCampaignSize: { type: Number, default: 0, min: 0 },

    // Phase 2+ flags (sync now, AMDS uses in Phase 3)
    warmupEnabled: { type: Boolean, default: true },
    reputationEnabled: { type: Boolean, default: true },

    // AMDS sync metadata
    amdsSyncedAt: { type: Date, default: null },
    amdsSyncError: { type: String, default: null },

    // Cached from AMDS webhooks (optional denormalization)
    creditsReserved: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

export const OrgEmailPolicy = mongoose.model('OrgEmailPolicy', orgEmailPolicySchema);
```

### Default limits by plan (example)

| Plan | Monthly credits | Daily limit | Hourly | Burst/min | Max campaign |
|------|-----------------|-------------|--------|-----------|--------------|
| Starter | 5,000 | 1,000 | 500 | 20 | 5,000 |
| Pro | 50,000 | 10,000 | 2,000 | 50 | 25,000 |
| Enterprise | 500,000 | 100,000 | 10,000 | 200 | 100,000 |

Seed `OrgEmailPolicy` on org creation from subscription plan.

---

## 4. Types — extend `amds-types.ts`

```typescript
// server/services/amds/amds-types.ts — add

export interface TenantPolicyPayload {
  status: 'active' | 'suspended';
  monthly_credits: number;
  credits_remaining: number;
  daily_send_limit: number;
  max_hourly_rate: number;
  burst_rate_per_min: number;
  max_campaign_size: number;
  warmup_enabled: boolean;
  reputation_enabled: boolean;
}

export interface TenantPolicyResponse extends TenantPolicyPayload {
  tenant_id: string;
  credits_reserved: number;
  first_send_at: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreditAllocationRequest {
  amount: number;
  reason?: string;
}

export type AmdsTenantEventType =
  | 'credit.reserved'
  | 'credit.consumed'
  | 'credit.released'
  | 'policy.limit_exceeded';

export interface AmdsTenantWebhookEvent {
  event_id: string;
  timestamp: string;
  event_type: AmdsTenantEventType;
  tenant_id: string;
  message_id?: string;
  credit?: {
    amount: number;
    balance_after: number;
    reserved_after: number;
  };
  policy?: {
    reason: string;
    limit?: number;
    remaining?: number;
  };
}

// Extend existing union
export type AmdsWebhookEventType =
  | 'message.delivered'
  | 'message.failed'
  | 'message.bounced'
  | 'message.complained'
  | 'message.opened'
  | 'message.clicked'
  | AmdsTenantEventType;
```

---

## 5. AMDS client methods

```typescript
// server/services/amds/amds-client.ts — add methods

async upsertTenantPolicy(tenantId: string, policy: TenantPolicyPayload): Promise<TenantPolicyResponse> {
  return this.request('PUT', `/v1/tenants/${encodeURIComponent(tenantId)}/policy`, policy);
}

async getTenantPolicy(tenantId: string): Promise<TenantPolicyResponse> {
  return this.request('GET', `/v1/tenants/${encodeURIComponent(tenantId)}/policy`);
}

async allocateCredits(tenantId: string, body: CreditAllocationRequest): Promise<TenantPolicyResponse> {
  return this.request('PATCH', `/v1/tenants/${encodeURIComponent(tenantId)}/credits`, body);
}

async suspendTenant(tenantId: string): Promise<TenantPolicyResponse> {
  return this.request('POST', `/v1/tenants/${encodeURIComponent(tenantId)}/suspend`, {});
}

async activateTenant(tenantId: string): Promise<TenantPolicyResponse> {
  return this.request('POST', `/v1/tenants/${encodeURIComponent(tenantId)}/activate`, {});
}
```

Map org ID to AMDS `tenant_id` — use existing convention (`org._id.toString()` or `org.amdsTenantId`).

---

## 6. Policy sync service

Call after any entitlement change.

```javascript
// server/services/amds/amds-policy-sync.js
import { OrgEmailPolicy } from '../../models/org-email-policy.js';
import { getAmdsClient } from './amds-client.js';

export function toAmdsPolicy(doc) {
  return {
    status: doc.status,
    monthly_credits: doc.monthlyCredits,
    credits_remaining: doc.creditsRemaining,
    daily_send_limit: doc.dailySendLimit,
    max_hourly_rate: doc.maxHourlyRate,
    burst_rate_per_min: doc.burstRatePerMin,
    max_campaign_size: doc.maxCampaignSize,
    warmup_enabled: doc.warmupEnabled,
    reputation_enabled: doc.reputationEnabled,
  };
}

export async function syncOrgPolicyToAmds(orgId) {
  const doc = await OrgEmailPolicy.findOne({ orgId });
  if (!doc) {
    throw new Error(`OrgEmailPolicy not found: ${orgId}`);
  }

  const client = getAmdsClient();
  try {
    const response = await client.upsertTenantPolicy(orgId, toAmdsPolicy(doc));
    doc.amdsSyncedAt = new Date();
    doc.amdsSyncError = null;
    doc.creditsReserved = response.credits_reserved;
    await doc.save();
    return response;
  } catch (err) {
    doc.amdsSyncError = err.message ?? 'sync failed';
    await doc.save();
    throw err;
  }
}

/** After credit pack purchase — update MongoDB then AMDS PATCH */
export async function allocateOrgCredits(orgId, amount, reason) {
  const doc = await OrgEmailPolicy.findOneAndUpdate(
    { orgId },
    {
      $inc: { creditsRemaining: amount, monthlyCredits: amount },
    },
    { new: true, upsert: false }
  );
  if (!doc) throw new Error(`OrgEmailPolicy not found: ${orgId}`);

  const client = getAmdsClient();
  const response = await client.allocateCredits(orgId, { amount, reason });
  doc.creditsRemaining = response.credits_remaining;
  doc.amdsSyncedAt = new Date();
  await doc.save();
  return doc;
}
```

### When to sync

| Trigger | Action |
|---------|--------|
| Org created | Create `OrgEmailPolicy` from plan → `syncOrgPolicyToAmds` |
| Subscription upgraded/downgraded | Update limits + credits → sync |
| Credit pack purchased | `allocateOrgCredits` |
| Admin suspends org | Set `status: suspended` → sync + `suspendTenant` |
| Admin reactivates | Set `status: active` → sync + `activateTenant` |
| Admin edits limits in Settings | Update doc → sync |

Use a **retry queue** (Bull or simple cron) for failed syncs — store `amdsSyncError` on doc.

---

## 7. Webhook handler — tenant events

```typescript
// server/services/amds/handlers/tenant-event-handler.ts
import { OrgEmailPolicy } from '../../../models/org-email-policy.js';
import type { AmdsTenantWebhookEvent } from '../amds-types.js';

export async function processTenantEvent(event: AmdsTenantWebhookEvent): Promise<void> {
  const orgId = event.tenant_id;

  switch (event.event_type) {
    case 'credit.reserved':
    case 'credit.consumed':
    case 'credit.released': {
      if (!event.credit) return;
      await OrgEmailPolicy.findOneAndUpdate(
        { orgId },
        {
          creditsRemaining: event.credit.balance_after,
          creditsReserved: event.credit.reserved_after,
        }
      );
      break;
    }
    case 'policy.limit_exceeded': {
      // Optional: log to org activity, notify admin
      console.warn('[AMDS] policy limit exceeded', orgId, event.policy);
      break;
    }
    default:
      break;
  }
}
```

Wire in webhook route:

```typescript
// server/routes/internal/amds-webhook.ts — after idempotency insert
import { processTenantEvent } from '../../services/amds/handlers/tenant-event-handler.js';

const TENANT_EVENTS = new Set([
  'credit.reserved',
  'credit.consumed',
  'credit.released',
  'policy.limit_exceeded',
]);

if (TENANT_EVENTS.has(event.event_type)) {
  await processTenantEvent(event);
  return res.json({ ok: true });
}

// existing message event routing…
await processCommunicationEvent(event);
```

**Important:** AMDS credit webhooks are the **consumption truth** for `creditsRemaining` / `creditsReserved`. LiteDesk billing allocation still originates in MongoDB, but in-flight state should follow AMDS webhooks.

---

## 8. Outbound send — handle new errors

Extend `AmdsApiError` parsing (if not already):

```javascript
// 402 — insufficient_credits
if (status === 402) {
  throw new AmdsApiError('insufficient_credits', 'Email credits exhausted. Purchase more or upgrade your plan.', 402);
}

// 422 — campaign_size_exceeded
if (status === 422 && body?.error === 'campaign_size_exceeded') {
  throw new AmdsApiError('campaign_size_exceeded', `Maximum campaign size is ${body.limit}`, 422);
}

// 429 — daily/hourly/burst
if (status === 429) {
  throw new AmdsApiError(body?.error ?? 'rate_limit_exceeded', 'Sending limit reached. Try again later.', 429);
}
```

### Helpdesk (`sendCaseReplyEmail.js`)

- Catch `insufficient_credits` → user-facing message + optional admin alert
- Do not retry 402/403

### Marketing (Track 4 campaign send)

- Pre-check: `recipients.length <= maxCampaignSize`
- Pre-check: `recipients.length <= creditsRemaining` (approximate; AMDS is authoritative)
- On 429: exponential backoff between chunks

---

## 9. Settings API (LiteDesk)

```javascript
// server/routes/settings/email-policy.js
// GET  /api/settings/email-policy        — org admin read
// PUT  /api/settings/email-policy/limits — update limits (enterprise admin)
// GET  /api/settings/email-policy/sync   — force re-sync to AMDS (debug)
```

`GET` response example:

```json
{
  "monthlyCredits": 100000,
  "creditsRemaining": 80000,
  "creditsReserved": 120,
  "dailySendLimit": 20000,
  "maxHourlyRate": 5000,
  "burstRatePerMin": 100,
  "maxCampaignSize": 50000,
  "status": "active",
  "amdsSyncedAt": "2026-07-02T10:00:00.000Z"
}
```

Do **not** expose AMDS API key to frontend — proxy through LiteDesk routes.

---

## 10. Settings UI (Phase 1 — minimal)

```vue
<!-- client/src/views/settings/EmailPolicy.vue -->
<template>
  <section class="email-policy">
    <h2>Email credits & limits</h2>
    <dl>
      <dt>Credits remaining</dt>
      <dd>{{ policy.creditsRemaining.toLocaleString() }}</dd>
      <dt>In flight (reserved)</dt>
      <dd>{{ policy.creditsReserved.toLocaleString() }}</dd>
      <dt>Daily send limit</dt>
      <dd>{{ formatLimit(policy.dailySendLimit) }}</dd>
      <dt>Max hourly rate</dt>
      <dd>{{ formatLimit(policy.maxHourlyRate) }}/hour</dd>
      <dt>Max campaign size</dt>
      <dd>{{ formatLimit(policy.maxCampaignSize) }}</dd>
    </dl>
    <p v-if="policy.amdsSyncError" class="error">Sync issue: {{ policy.amdsSyncError }}</p>
  </section>
</template>
```

Campaign composer (Track 4 UI) — add before send:

```text
Recipients:     25,000
Credits needed: 25,000
Credits left:   80,000
```

Phase 3 adds reputation + effective rate + ETA.

---

## 11. Billing hooks

```javascript
// server/services/billing/email-credits.js

export async function onSubscriptionActivated(orgId, plan) {
  await OrgEmailPolicy.findOneAndUpdate(
    { orgId },
    {
      $set: {
        monthlyCredits: plan.emailCredits,
        creditsRemaining: plan.emailCredits,
        dailySendLimit: plan.dailySendLimit,
        maxHourlyRate: plan.maxHourlyRate,
        burstRatePerMin: plan.burstRatePerMin,
        maxCampaignSize: plan.maxCampaignSize,
        status: 'active',
      },
    },
    { upsert: true }
  );
  await syncOrgPolicyToAmds(orgId);
}

export async function onCreditPackPurchased(orgId, packSize) {
  await allocateOrgCredits(orgId, packSize, 'credit_pack_purchase');
}
```

Hook from existing Stripe/subscription webhook handlers.

---

## 12. E2E validation script

```bash
# LiteDesk/server/scripts/validate-amds-track6-phase1.js
# 1. Create test org policy in MongoDB
# 2. syncOrgPolicyToAmds(orgId)
# 3. GET AMDS policy — match credits
# 4. Send case email — credits reserved then consumed via webhook
# 5. Set credits_remaining=0, sync, send — expect 402
```

Run with AMDS `npm run dev` + LiteDesk `npm run dev`.

---

## 13. Checklist

```
[ ] OrgEmailPolicy model + plan defaults on org create
[ ] amds-client — upsertTenantPolicy, allocateCredits, suspend/activate
[ ] amds-policy-sync.js + retry on failure
[ ] tenant-event-handler — credit.* webhooks
[ ] amds-webhook route — tenant event branch
[ ] sendCaseReplyEmail — 402/429 handling
[ ] Settings API + EmailPolicy.vue
[ ] Billing hooks — subscription + credit pack
[ ] validate-amds-track6-phase1.js
```

---

## 14. Out of scope (Phase 2–3)

| Feature | Phase |
|---------|-------|
| Sender reputation score UI | Phase 2 |
| Effective throughput + ETA | Phase 3 |
| Warm-up progress display | Phase 3 |
| Reputation guidance panel | Phase 4 |

Sync `warmup_enabled` and `reputation_enabled` now so AMDS has flags ready.

---

## 15. Testing matrix

| Scenario | LiteDesk | AMDS |
|----------|----------|------|
| New org | Policy created + synced | PUT policy 200 |
| Send email | Communication created | Reserve → deliver → consume |
| No credits | UI error | 402 |
| Suspended org | Send blocked in UI | 403 |
| Campaign too large | Pre-check in composer | 422 |
| Credit pack | Mongo + PATCH credits | credits_remaining += amount |

---

*Maintained in AMDS repo at `docs/LITEDESK-TRACK-6-PHASE1-DRAFT.md`. Update when AMDS API changes.*

**Last updated:** July 2, 2026
