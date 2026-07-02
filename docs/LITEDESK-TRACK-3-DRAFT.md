# LiteDesk Track 3 — Implementation Draft

**Audience:** LiteDesk backend developers  
**AMDS dependency:** Track 3 complete — see [TRACK-3-COMPLETE.md](./TRACK-3-COMPLETE.md)  
**Prerequisite:** Track 1 integration done (`AmdsClient`, webhooks, Communication model)

This document is a **copy-paste-ready draft** for the LiteDesk repo. Paths follow the layout in [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md).

---

## 1. Files to add or modify

| File | Action |
|------|--------|
| `server/services/amds/amds-types.ts` | Extend types |
| `server/services/amds/amds-client.ts` | Add methods + retry + typed errors |
| `server/services/amds/amds-errors.ts` | **New** — `AmdsApiError` class |
| `server/services/amds/handlers/communication-event-handler.ts` | **New** — unified webhook → Communication |
| `server/services/amds/handlers/bounce-contact-handler.ts` | **New** — hard bounce → contact |
| `server/routes/internal/amds-webhook.ts` | Route `message.bounced` |
| `server/routes/settings/amds-domains.ts` | **New** — org admin domain CRUD (proxy AMDS) |
| `server/services/communications/sendCaseReplyEmail.js` | Handle 422/403 from AMDS |
| `server/models/communication.js` | Allow `status: 'bounced'`, bounce metadata |

---

## 2. Types — `amds-types.ts`

Add/update these exports (merge with existing file):

```typescript
// server/services/amds/amds-types.ts

export interface AmdsAddress {
  email: string;
  name?: string;
}

export interface SendMessageRequest {
  idempotency_key: string;
  tenant_id: string;
  from: AmdsAddress;
  to: AmdsAddress[];
  cc?: AmdsAddress[];
  bcc?: AmdsAddress[];
  subject: string;
  content: { html?: string; text?: string };
  metadata?: Record<string, unknown>;
  tags?: string[];
  scheduled_at?: string; // ISO 8601 — Track 3
}

export interface SendMessageResponse {
  message_id: string;
  status: 'queued';
  queue: 'transaction';
  created_at: string;
}

export type AmdsMessageStatus =
  | 'queued'
  | 'scheduled'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'dead_letter'
  | 'bounced';

export interface MessageEvent {
  event_type: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface MessageStatusResponse {
  message_id: string;
  tenant_id: string;
  status: AmdsMessageStatus;
  queue: string;
  subject: string;
  to: AmdsAddress[];
  smtp_response: string | null;
  error_message: string | null;
  attempt_count: number;
  metadata: Record<string, unknown> | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  events?: MessageEvent[];
  dead_letter?: { failure_reason: string; attempt_count: number; moved_at: string } | null;
}

// --- Track 3: domains ---

export interface DnsRecord {
  type: 'TXT' | 'CNAME';
  name: string;
  value: string;
  purpose: 'spf' | 'dkim' | 'dmarc';
}

export interface DomainResponse {
  domain: string;
  tenant_id: string;
  status: 'pending' | 'verified';
  dkim_selector: string;
  dns_records: DnsRecord[];
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
  verified_at: string | null;
  created_at: string;
  verification?: { spf: boolean; dkim: boolean; dmarc: boolean };
}

export interface RegisterDomainRequest {
  tenant_id: string;
  domain: string;
}

export interface VerifyDomainRequest {
  tenant_id: string;
}

// --- Track 3: suppressions ---

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

export interface SuppressionEntry {
  email: string;
  reason: SuppressionReason;
  source_message_id: string | null;
  created_at: string;
}

export interface SuppressionListResponse {
  tenant_id: string;
  suppressions: SuppressionEntry[];
}

export interface CreateSuppressionRequest {
  tenant_id: string;
  email: string;
  reason?: SuppressionReason;
}

// --- Webhooks (extend existing) ---

export type AmdsWebhookEventType =
  | 'message.delivered'
  | 'message.failed'
  | 'message.bounced'
  | 'message.complained'; // future

export interface AmdsWebhookEvent {
  event_id: string;
  event_type: AmdsWebhookEventType;
  timestamp: string;
  tenant_id: string;
  message_id: string;
  metadata?: {
    litedesk_module?: string;
    litedesk_entity_id?: string;
    litedesk_reply_id?: string;
    litedesk_communication_id?: string;
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
}

export interface AmdsErrorBody {
  error: string;
  details?: unknown;
  suppressed?: string[]; // 422
  domain?: string;       // 403
  remaining?: number;      // 429
}
```

---

## 3. Typed errors — `amds-errors.ts`

```typescript
// server/services/amds/amds-errors.ts

import type { AmdsErrorBody } from './amds-types.js';

export class AmdsApiError extends Error {
  readonly status: number;
  readonly body: AmdsErrorBody;

  constructor(status: number, body: AmdsErrorBody) {
    super(body.error ?? `AMDS HTTP ${status}`);
    this.name = 'AmdsApiError';
    this.status = status;
    this.body = body;
  }

  get isRetryable(): boolean {
    return this.status >= 500 || this.status === 429;
  }

  get isSuppressedRecipient(): boolean {
    return this.status === 422;
  }

  get isDomainNotVerified(): boolean {
    return this.status === 403;
  }
}
```

---

## 4. Client — `amds-client.ts`

Replace `wrapError` and add methods below. Keep existing `sendMessage` / `getMessageStatus`.

```typescript
// server/services/amds/amds-client.ts

import axios, { AxiosError, AxiosInstance } from 'axios';
import { AmdsApiError } from './amds-errors.js';
import type {
  SendMessageRequest,
  SendMessageResponse,
  MessageStatusResponse,
  AmdsErrorBody,
  RegisterDomainRequest,
  VerifyDomainRequest,
  DomainResponse,
  CreateSuppressionRequest,
  SuppressionEntry,
  SuppressionListResponse,
} from './amds-types.js';

const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_SEND_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

export class AmdsClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/$/, ''),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
  }

  /** Send with retry on 429 / 5xx (idempotency_key makes retries safe). */
  async sendMessageWithRetry(params: SendMessageRequest): Promise<SendMessageResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        return await this.sendMessage(params);
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
        throw err;
      }
    }

    throw lastError;
  }

  async sendMessage(params: SendMessageRequest): Promise<SendMessageResponse> {
    const { data } = await this.http.post<SendMessageResponse>('/v1/messages', params);
    return data;
  }

  async getMessageStatus(messageId: string): Promise<MessageStatusResponse> {
    const { data } = await this.http.get<MessageStatusResponse>(`/v1/messages/${messageId}`);
    return data;
  }

  // --- Track 3: domains ---

  async registerDomain(params: RegisterDomainRequest): Promise<DomainResponse> {
    const { data } = await this.http.post<DomainResponse>('/v1/domains', params);
    return data;
  }

  async getDomain(tenantId: string, domain: string): Promise<DomainResponse> {
    const { data } = await this.http.get<DomainResponse>(
      `/v1/domains/${encodeURIComponent(domain)}`,
      { params: { tenant_id: tenantId } }
    );
    return data;
  }

  async verifyDomain(tenantId: string, domain: string): Promise<DomainResponse> {
    const { data } = await this.http.post<DomainResponse>(
      `/v1/domains/${encodeURIComponent(domain)}/verify`,
      { tenant_id: tenantId }
    );
    return data;
  }

  // --- Track 3: suppressions ---

  async listSuppressions(tenantId: string, email?: string): Promise<SuppressionListResponse> {
    const { data } = await this.http.get<SuppressionListResponse>('/v1/suppressions', {
      params: { tenant_id: tenantId, ...(email ? { email } : {}) },
    });
    return data;
  }

  async createSuppression(params: CreateSuppressionRequest): Promise<SuppressionEntry> {
    const { data } = await this.http.post<SuppressionEntry>('/v1/suppressions', params);
    return data;
  }

  async deleteSuppression(tenantId: string, email: string): Promise<void> {
    await this.http.delete(`/v1/suppressions/${encodeURIComponent(email)}`, {
      params: { tenant_id: tenantId },
    });
  }

  private wrapError(err: unknown): never {
    if (err instanceof AxiosError && err.response) {
      const body = (err.response.data ?? { error: err.message }) as AmdsErrorBody;
      throw new AmdsApiError(err.response.status, body);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Wire-up:** wrap existing method bodies with try/catch → `this.wrapError(err)`, or use an axios response interceptor.

**Outbound send:** replace `amdsClient.sendMessage(...)` with `amdsClient.sendMessageWithRetry(...)` in `sendCaseReplyEmail.js` and CRM email paths.

---

## 5. Communication webhook handler — `communication-event-handler.ts`

Uses the **Communication** model (implemented path), not ticket `replies[]`.

```typescript
// server/services/amds/handlers/communication-event-handler.ts

import type { AmdsWebhookEvent } from '../amds-types.js';
import { CommunicationModel } from '../../models/communication.js'; // adjust import
import { processBounceContact } from './bounce-contact-handler.js';
import { notifyAgentBounce } from '../../notifications/bounce-notify.js'; // your notifier

type DeliveryStatus = 'queued' | 'delivered' | 'failed' | 'bounced';

export async function processCommunicationEvent(event: AmdsWebhookEvent): Promise<void> {
  const communication = await findCommunication(event);
  if (!communication) {
    return;
  }

  switch (event.event_type) {
    case 'message.delivered':
      await updateCommunication(communication._id, {
        status: 'delivered',
        'metadata.deliveryUpdatedAt': new Date(event.timestamp),
        'metadata.lastAmdsEvent': event.event_type,
      });
      break;

    case 'message.failed':
      await updateCommunication(communication._id, {
        status: 'failed',
        'metadata.deliveryError': event.delivery?.error ?? 'Delivery failed',
        'metadata.deliveryUpdatedAt': new Date(event.timestamp),
        'metadata.lastAmdsEvent': event.event_type,
      });
      await notifyAgentBounce({
        communication,
        event,
        severity: 'failed',
      });
      break;

    case 'message.bounced': {
      const classification = event.bounce?.classification ?? 'hard';
      await updateCommunication(communication._id, {
        status: 'bounced',
        'metadata.bounceClassification': classification,
        'metadata.bounceDiagnostic': event.bounce?.diagnostic ?? null,
        'metadata.bounceRecipient': event.bounce?.recipient ?? null,
        'metadata.deliveryUpdatedAt': new Date(event.timestamp),
        'metadata.lastAmdsEvent': event.event_type,
      });

      if (classification === 'hard') {
        await processBounceContact({
          tenantId: event.tenant_id,
          email: event.bounce?.recipient ?? communication.toEmail,
          sourceMessageId: event.message_id,
        });
      }

      await notifyAgentBounce({
        communication,
        event,
        severity: classification === 'hard' ? 'hard_bounce' : 'soft_bounce',
      });
      break;
    }

    default:
      break;
  }

  // Case timeline / activity (if moduleKey === 'cases')
  await appendCaseActivityFromEvent(communication, event);
}

async function findCommunication(event: AmdsWebhookEvent) {
  const byId = event.metadata?.litedesk_communication_id;
  if (byId) {
    return CommunicationModel.findById(byId);
  }
  return CommunicationModel.findOne({
    'metadata.amdsMessageId': event.message_id,
  });
}

async function updateCommunication(
  id: unknown,
  fields: Record<string, unknown>
): Promise<void> {
  await CommunicationModel.updateOne({ _id: id }, { $set: fields });
}
```

**Send path:** when creating a Communication and calling AMDS, include in metadata:

```javascript
metadata: {
  litedesk_module: 'cases',           // or 'crm'
  litedesk_entity_id: caseId,
  litedesk_communication_id: communication._id.toString(),
}
```

---

## 6. Hard bounce → contact — `bounce-contact-handler.ts`

```typescript
// server/services/amds/handlers/bounce-contact-handler.ts

import { amdsClient } from '../../../config/amds.js';
import { ContactModel } from '../../models/contact.js'; // People / CRM

export async function processBounceContact(params: {
  tenantId: string;
  email: string;
  sourceMessageId: string;
}): Promise<void> {
  const email = params.email.toLowerCase();

  // LiteDesk-side suppress flag
  await ContactModel.updateOne(
    { orgId: params.tenantId, email },
    {
      $set: {
        emailValid: false,
        emailSuppressedAt: new Date(),
        emailSuppressionReason: 'hard_bounce',
        emailSuppressionSource: params.sourceMessageId,
      },
    }
  );

  // Keep AMDS suppression list in sync (idempotent)
  try {
    await amdsClient.createSuppression({
      tenant_id: params.tenantId,
      email,
      reason: 'hard_bounce',
    });
  } catch (err) {
    // Log — AMDS may already have suppressed via bounce pipeline
    console.warn('[bounce] AMDS createSuppression:', err);
  }
}
```

Adjust field names to match your Contact/People schema (`emailValid`, `orgId`, etc.).

---

## 7. Webhook route — patch `amds-webhook.ts`

```typescript
// server/routes/internal/amds-webhook.ts — changes only

import { processCommunicationEvent } from '../../services/amds/handlers/communication-event-handler.js';

// Inside handler, after idempotency insert succeeds:

await processCommunicationEvent(event);

// Remove or delegate old helpdesk-only handler — Communication handler
// covers delivered / failed / bounced for all modules.
```

Ensure `AmdsWebhookEvent` type includes `message.bounced` (section 2).

---

## 8. Outbound send — patch `sendCaseReplyEmail.js`

```javascript
// server/services/communications/sendCaseReplyEmail.js — illustrative diff

const { amdsClient } = require('../../config/amds');
const { AmdsApiError } = require('../amds/amds-errors');

async function sendCaseReplyEmail({ orgId, caseId, communication, ... }) {
  try {
    const result = await amdsClient.sendMessageWithRetry({
      idempotency_key: `litedesk-cases-${orgId}-${communication._id}`,
      tenant_id: orgId,
      from: { email: fromEmail, name: fromName },
      to: [{ email: toEmail, name: toName }],
      subject,
      content: { html, text },
      metadata: {
        litedesk_module: 'cases',
        litedesk_entity_id: String(caseId),
        litedesk_communication_id: String(communication._id),
      },
      tags: ['helpdesk', 'transactional'],
      // scheduled_at: scheduledAt,  // optional — ISO string
    });

    await CommunicationModel.updateOne(
      { _id: communication._id },
      {
        $set: {
          status: 'queued',
          'metadata.amdsMessageId': result.message_id,
          'metadata.amdsQueuedAt': result.created_at,
        },
      }
    );

    return result;
  } catch (err) {
    if (err instanceof AmdsApiError) {
      if (err.isSuppressedRecipient) {
        throw userFacingError(
          `Cannot send — recipient is suppressed: ${err.body.suppressed?.join(', ')}`
        );
      }
      if (err.isDomainNotVerified) {
        throw userFacingError(
          `Sending domain not verified: ${err.body.domain}. Ask an admin to verify DNS in Settings.`
        );
      }
    }
    throw err;
  }
}
```

Same pattern for CRM `POST /api/communications/email`.

---

## 9. Org admin — domain settings routes

LiteDesk proxies AMDS; Vue calls LiteDesk API only.

```typescript
// server/routes/settings/amds-domains.ts

import { Router } from 'express';
import { requireOrgAdmin } from '../../middleware/auth.js';
import { amdsClient } from '../../config/amds.js';

const router = Router();

/** POST /api/settings/email/domains — register */
router.post('/', requireOrgAdmin, async (req, res, next) => {
  try {
    const orgId = req.user.orgId;
    const { domain } = req.body;
    const result = await amdsClient.registerDomain({ tenant_id: orgId, domain });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/settings/email/domains/:domain */
router.get('/:domain', requireOrgAdmin, async (req, res, next) => {
  try {
    const result = await amdsClient.getDomain(req.user.orgId, req.params.domain);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** POST /api/settings/email/domains/:domain/verify */
router.post('/:domain/verify', requireOrgAdmin, async (req, res, next) => {
  try {
    const result = await amdsClient.verifyDomain(req.user.orgId, req.params.domain);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
```

**Vue 3 (Settings → Integrations → Email → Domains):**

1. Form: enter domain → `POST /api/settings/email/domains`
2. Show `dns_records[]` (copy buttons for TXT values)
3. “Verify DNS” → `POST .../verify` → show `spf_verified`, `dkim_verified`, `dmarc_verified`
4. Badge: `pending` / `verified`

---

## 10. Communication model fields

Extend allowed `status` and metadata:

```javascript
// status enum: 'queued' | 'delivered' | 'failed' | 'bounced'

metadata: {
  amdsMessageId: String,
  deliveryUpdatedAt: Date,
  deliveryError: String,          // failed
  bounceClassification: String, // 'hard' | 'soft'
  bounceDiagnostic: String,
  bounceRecipient: String,
  lastAmdsEvent: String,
}
```

**Case timeline / Vue:** map `bounced` → label “Bounced”, color warning; show `bounceDiagnostic` on hover.

---

## 11. Agent notification — `bounce-notify.js` (sketch)

```typescript
// server/services/notifications/bounce-notify.ts

export async function notifyAgentBounce(params: {
  communication: { _id: unknown; assignedTo?: string; caseId?: string };
  event: AmdsWebhookEvent;
  severity: 'failed' | 'hard_bounce' | 'soft_bounce';
}): Promise<void> {
  const { communication, event, severity } = params;
  const recipient = event.bounce?.recipient ?? event.delivery?.recipient ?? 'recipient';
  const reason = event.bounce?.diagnostic ?? event.delivery?.error ?? 'Unknown';

  // Use your existing notification service
  await NotificationService.create({
    userId: communication.assignedTo,
    type: 'email_bounce',
    title:
      severity === 'hard_bounce'
        ? `Email permanently bounced — ${recipient}`
        : severity === 'soft_bounce'
          ? `Email temporarily bounced — ${recipient}`
          : `Email delivery failed — ${recipient}`,
    body: reason,
    link: `/cases/${communication.caseId}`,
  });
}
```

---

## 12. Local test procedure

**Terminal 1 — AMDS**

```bash
npm run docker:up && npm run db:migrate && npm run dev
```

**Terminal 2 — LiteDesk** (with webhook URL pointing at LiteDesk)

**Test bounce webhook without real SMTP bounce:**

```bash
# After sending a case email, note message_id from Communication.metadata.amdsMessageId
cd AMDS
npm run simulate:bounce -- <message_id> <org_id> hard
```

**Expected in LiteDesk:**

1. Communication `status` → `bounced`
2. Contact `emailValid` → false (hard bounce)
3. Agent notification created
4. Case activity updated

**Test domain flow:**

1. LiteDesk Settings → register `localhost.test`
2. AMDS with `DNS_VERIFY_BYPASS=true` → verify succeeds
3. Send case email from `support@localhost.test`

---

## 13. Implementation checklist

```
[x] amds-types.js — Track 3 types
[x] amds-errors.js — AmdsApiError
[x] amds-client.js — retry, domains, suppressions, 429
[x] send path — 422/403 + queue sendErrorCode + scheduled_at
[x] metadata.litedesk_communication_id on AMDS send
[x] communicationEventHandler — delivered / failed / bounced
[x] bounceContactHandler — EmailSuppression + AMDS createSuppression
[x] bounceNotify — agent alert
[x] webhook route — communication + helpdesk handlers
[x] Communication model — bounced + metadata
[x] Vue — case timeline delivery badges
[x] settings email/domains + Integrations UI
[x] Manual simulate:bounce — `LiteDesk/server/scripts/validate-amds-track3-bounce.js` (validated 2026-06-30)
```

---

## 14. Explicitly out of scope (LiteDesk)

| Item | Owner |
|------|--------|
| DKIM signing, DNS generation | AMDS |
| AMDS suppression on bounce | AMDS (LiteDesk syncs contact + optional API call) |
| `message.complained` | Future (Track 3+ AMDS) |
| Open/click tracking | Track 4 |
| Campaign batch send | Track 4 |

---

*Maintained in AMDS repo at `docs/LITEDESK-TRACK-3-DRAFT.md`. Copy into LiteDesk repo or link from LiteDesk integration docs.*
