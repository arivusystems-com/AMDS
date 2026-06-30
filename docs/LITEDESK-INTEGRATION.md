# LiteDesk ↔ AMDS Integration Guide

**Version:** 1.1  
**Date:** June 29, 2026  
**Phase:** Track 1 complete — building Tracks 2–4 locally, OCI deploy at end ([BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md))  
**Audience:** LiteDesk backend developers  

This document describes the **LiteDesk ↔ AMDS** integration contract. Track 1 is **complete on both sides** for local development (AMDS → Mailpit, LiteDesk webhooks, CRM + Cases outbound). Use this as the reference when extending integration through local build tracks and final OCI deploy.

See also: [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md) · [AMDS-END-TO-END-ROADMAP.md](./AMDS-END-TO-END-ROADMAP.md)

---

## Implementation status (Phase 0a)

### AMDS repo (this repository) — complete

| Item | Status |
|------|--------|
| Monorepo (`gateway`, `worker`, `shared`) | Done |
| Docker — Postgres, Redis, Mailpit | Done |
| `GET /health`, `GET /ready` | Done |
| PostgreSQL schema + migrations | Done |
| `POST /v1/messages` (202) + idempotency (200 on duplicate) | Done |
| `GET /v1/messages/:id` | Done |
| API key auth (`Authorization: Bearer`) | Done |
| Worker → Mailpit SMTP | Done |
| Webhooks `message.delivered` / `message.failed` (HMAC-signed) | Done |
| Automated validation | Done — `npm run validate:phase-0a` |
| CI (build + validation) | Done — `.github/workflows/ci.yml` |

### LiteDesk repo — complete

| Item | Status |
|------|--------|
| `AmdsClient` + env config | Done |
| Webhook route + HMAC verification | Done |
| `amds_webhook_events` idempotency store | Done |
| CRM + Cases outbound via AMDS (`POST /api/communications/email`) | Done |
| Settings → Integrations → Email → **AMDS** provider | Done |
| Webhook updates Communication + Case activity | Done |
| Case timeline / threads expose `deliveryStatus`, `amdsMessageId` | Done |
| Delivery poll fallback `GET /api/communications/:id/delivery-status` | Done |
| `sendCaseReplyEmail.js` (helpdesk / cases contract) | Done |

**Exit criteria met:**

```text
LiteDesk send → AMDS POST /v1/messages → Worker → Mailpit → webhook → delivered
```

**Not yet started:** Tracks 2–4 (see [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md)). OCI deploy and real inbox delivery happen once all local tracks pass.

> **Note:** LiteDesk stores AMDS correlation on the **Communication** model (`metadata.amdsMessageId`, `status`) rather than directly on ticket `replies[]`. Sections 5.2–5.4 below show the original ticket-reply pattern; the implemented path uses Communication + Cases — see §7 checklist for the live wiring.

---

## 1. Integration overview

```
LiteDesk (Node.js + MongoDB)              AMDS (separate repo)
┌─────────────────────────────┐           ┌─────────────────────────────┐
│ Helpdesk: agent sends reply │           │ Gateway  :8080              │
│         │                   │  POST     │ Worker   → Mailpit/SMTP     │
│         ▼                   │ /v1/messages                            │
│  AmdsClient.sendMessage()   ├──────────►│                             │
│         │                   │  202      │                             │
│         ▼                   │◄──────────┤                             │
│  Store amds_message_id      │           │                             │
│  on ticket / reply doc      │           │                             │
│         │                   │  POST     │                             │
│         ▼                   │ /api/internal/webhooks/amds             │
│  Webhook handler            │◄──────────┤ message.delivered / .failed   │
│  Update delivery_status     │           │                             │
└─────────────────────────────┘           └─────────────────────────────┘
```

**Principle:** LiteDesk decides *what* to send. AMDS decides *how* it is delivered.

**What LiteDesk stores (MongoDB):** correlation fields only — `amds_message_id`, `delivery_status`, timestamps.  
**What AMDS stores (PostgreSQL):** full delivery pipeline — queue state, SMTP attempts, events.

---

## 2. Environment variables (LiteDesk)

Add these to LiteDesk `.env`:

```bash
# AMDS API (LiteDesk → AMDS)
AMDS_BASE_URL=http://localhost:8080
AMDS_API_KEY=amds_dev_key

# Webhook verification (AMDS → LiteDesk)
AMDS_WEBHOOK_SECRET=dev_webhook_secret
AMDS_WEBHOOK_PATH=/api/internal/webhooks/amds
```

| Variable | Local value | Production notes |
|----------|-------------|------------------|
| `AMDS_BASE_URL` | `http://localhost:8080` | `https://amds.internal:8080` (private VCN IP or internal DNS) |
| `AMDS_API_KEY` | `amds_dev_key` | Must match `AMDS_API_KEY` on AMDS side |
| `AMDS_WEBHOOK_SECRET` | `dev_webhook_secret` | Must match `WEBHOOK_SIGNING_SECRET` on AMDS side |
| `AMDS_WEBHOOK_PATH` | `/api/internal/webhooks/amds` | Must match `LITEDESK_WEBHOOK_URL` path on AMDS |

**AMDS side (for reference):** AMDS `.env` must set:

```bash
LITEDESK_WEBHOOK_URL=http://localhost:3000/api/internal/webhooks/amds
WEBHOOK_SIGNING_SECRET=dev_webhook_secret   # same as AMDS_WEBHOOK_SECRET
AMDS_API_KEY=amds_dev_key                   # same as LiteDesk AMDS_API_KEY
```

On production, use the LiteDesk private IP or internal DNS in `LITEDESK_WEBHOOK_URL`.

---

## 3. Deliverable 1 — `AmdsClient` ✅ Done (LiteDesk)

### 3.1 Purpose

HTTP client wrapper for AMDS REST API. All AMDS communication from LiteDesk goes through this class — no direct SMTP, no scattered `fetch` calls.

### 3.2 Suggested file layout

```
server/
├── config/
│   └── amds.ts                 # singleton client + env validation
├── services/
│   └── amds/
│       ├── amds-client.ts      # HTTP client
│       ├── amds-types.ts       # request/response types
│       └── index.ts
```

### 3.3 TypeScript types

Mirror the AMDS API contract (Phase 0a):

```typescript
// server/services/amds/amds-types.ts

export interface AmdsAddress {
  email: string;
  name?: string;
}

export interface SendMessageRequest {
  idempotency_key: string;       // max 256 chars, required
  tenant_id: string;             // LiteDesk org ID, max 128 chars
  from: AmdsAddress;
  to: AmdsAddress[];             // 1–50 recipients
  cc?: AmdsAddress[];
  bcc?: AmdsAddress[];
  subject: string;               // max 998 chars
  content: {
    html?: string;
    text?: string;
  };                               // at least one of html or text required
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface SendMessageResponse {
  message_id: string;            // UUID
  status: 'queued';
  queue: 'transaction';
  created_at: string;            // ISO 8601
}

export type MessageStatus = 'queued' | 'processing' | 'delivered' | 'failed';

export interface MessageStatusResponse {
  message_id: string;
  tenant_id: string;
  status: MessageStatus;
  queue: string;
  subject: string;
  to: AmdsAddress[];
  smtp_response: string | null;
  error_message: string | null;
  attempt_count: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface AmdsApiError {
  error: string;
  details?: unknown;
}
```

### 3.4 Client implementation

```typescript
// server/services/amds/amds-client.ts

import axios, { AxiosError, AxiosInstance } from 'axios';
import type {
  SendMessageRequest,
  SendMessageResponse,
  MessageStatusResponse,
  AmdsApiError,
} from './amds-types.js';

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

  /**
   * Queue a transactional email for delivery.
   * Returns 202 for new messages, 200 for idempotent duplicates (same key).
   */
  async sendMessage(params: SendMessageRequest): Promise<SendMessageResponse> {
    try {
      const { data } = await this.http.post<SendMessageResponse>('/v1/messages', params);
      return data;
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  /** Poll delivery status (fallback if webhook is delayed or missed). */
  async getMessageStatus(messageId: string): Promise<MessageStatusResponse> {
    try {
      const { data } = await this.http.get<MessageStatusResponse>(`/v1/messages/${messageId}`);
      return data;
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  private wrapError(err: unknown): Error {
    if (err instanceof AxiosError && err.response) {
      const body = err.response.data as AmdsApiError;
      const msg = body?.error ?? err.message;
      const detail = body?.details ? ` — ${JSON.stringify(body.details)}` : '';
      return new Error(`AMDS ${err.response.status}: ${msg}${detail}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
```

### 3.5 Singleton registration

```typescript
// server/config/amds.ts

import { AmdsClient } from '../services/amds/amds-client.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export const amdsClient = new AmdsClient(
  requireEnv('AMDS_BASE_URL'),
  requireEnv('AMDS_API_KEY')
);
```

### 3.6 API reference (implemented in AMDS today)

#### `POST /v1/messages`

**Auth:** `Authorization: Bearer <AMDS_API_KEY>`

**Request body:**

```json
{
  "idempotency_key": "litedesk-helpdesk-org_abc-ticket-88421-reply-3",
  "tenant_id": "org_abc123",
  "from": { "email": "support@customer.com", "name": "Acme Support" },
  "to": [{ "email": "user@example.com", "name": "Jane Doe" }],
  "subject": "Re: Your ticket #88421",
  "content": {
    "html": "<p>We resolved your issue...</p>",
    "text": "We resolved your issue..."
  },
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421",
    "litedesk_reply_id": "reply_3"
  },
  "tags": ["helpdesk", "transactional"]
}
```

**Responses:**

| Status | Meaning |
|--------|---------|
| `202 Accepted` | New message queued |
| `200 OK` | Duplicate `idempotency_key` for same tenant — returns existing `message_id` |
| `400 Bad Request` | Validation error (see `details` in body) |
| `401 Unauthorized` | Missing or invalid API key |

**Success body:**

```json
{
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "queue": "transaction",
  "created_at": "2026-06-29T10:00:00.000Z"
}
```

#### `GET /v1/messages/:id`

**Auth:** same Bearer token.

**Success body:**

```json
{
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "tenant_id": "org_abc123",
  "status": "delivered",
  "queue": "transaction",
  "subject": "Re: Your ticket #88421",
  "to": [{ "email": "user@example.com", "name": "Jane Doe" }],
  "smtp_response": "250 2.0.0 OK",
  "error_message": null,
  "attempt_count": 1,
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421"
  },
  "created_at": "2026-06-29T10:00:00.000Z",
  "updated_at": "2026-06-29T10:00:05.000Z",
  "delivered_at": "2026-06-29T10:00:05.000Z"
}
```

### 3.7 Idempotency key format

Generate a deterministic key so retries and double-clicks do not send duplicate emails.

**Recommended pattern:**

```
litedesk-{module}-{tenant_id}-{entity_id}-{action}-{sequence}
```

**Helpdesk reply example:**

```typescript
function buildIdempotencyKey(params: {
  tenantId: string;
  ticketId: string;
  replyId: string;
}): string {
  return `litedesk-helpdesk-${params.tenantId}-ticket-${params.ticketId}-reply-${params.replyId}`;
}
```

Use the **reply document `_id`** (or a client-generated UUID stored on the reply before send) as `replyId`. Never use a timestamp alone — that breaks idempotency on retry.

### 3.8 Retry policy (LiteDesk → AMDS)

| AMDS response | LiteDesk action |
|---------------|-----------------|
| `202` / `200` | Success — store `message_id` |
| `400` | Do not retry — fix payload, surface error to agent |
| `401` | Do not retry — config/ops issue |
| `5xx` / timeout | Retry up to 3 times with exponential backoff (1s, 2s, 4s) |

Because AMDS deduplicates by `idempotency_key`, retries are safe.

---

## 4. Deliverable 2 — Webhook route ✅ Done (LiteDesk)

### 4.1 Purpose

Receive delivery events from AMDS and update LiteDesk MongoDB records. Must verify HMAC signature and be idempotent on `event_id`.

### 4.2 Route

```
POST /api/internal/webhooks/amds
```

- **Not** called by the browser or Vue frontend — internal only.
- In production, restrict to AMDS private IP via firewall/security list if possible.
- Return `200` quickly; do heavy work async if needed.

### 4.3 Signature verification

AMDS signs every webhook with HMAC-SHA256:

```
signature = HMAC-SHA256(WEBHOOK_SIGNING_SECRET, "{timestamp}.{raw_json_body}")
```

**Headers from AMDS:**

| Header | Description |
|--------|-------------|
| `X-AMDS-Timestamp` | Unix seconds (string) |
| `X-AMDS-Signature` | Hex-encoded HMAC digest |

**Verification middleware:**

```typescript
// server/middleware/verify-amds-signature.ts

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const MAX_AGE_SECONDS = 300; // 5 minutes

export function verifyAmdsSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AMDS_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const timestamp = req.headers['x-amds-timestamp'] as string | undefined;
  const signature = req.headers['x-amds-signature'] as string | undefined;

  if (!timestamp || !signature) {
    res.status(401).json({ error: 'Missing signature headers' });
    return;
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
  if (age > MAX_AGE_SECONDS) {
    res.status(401).json({ error: 'Timestamp too old' });
    return;
  }

  // req.body must be the raw Buffer — configure express.raw() or capture raw body
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(500).json({ error: 'Raw body not available for verification' });
    return;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  next();
}
```

**Express raw body setup** (required — JSON parser mutates the body string):

```typescript
app.post(
  '/api/internal/webhooks/amds',
  express.raw({ type: 'application/json' }),
  verifyAmdsSignature,
  amdsWebhookHandler
);
```

After verification, parse JSON manually in the handler:

```typescript
const event = JSON.parse(req.body.toString('utf8'));
```

### 4.4 Webhook event types (Phase 0a)

| `event_type` | When | LiteDesk action |
|--------------|------|-----------------|
| `message.delivered` | SMTP accepted (250 OK) | Set `delivery_status: 'delivered'` |
| `message.failed` | SMTP or worker error | Set `delivery_status: 'failed'`, notify agent |

Future phases will add `message.bounced`, `message.opened`, `message.clicked`, `message.complained`.

### 4.5 Event payload shape

```typescript
// server/services/amds/amds-types.ts (add)

export interface AmdsWebhookEvent {
  event_id: string;              // e.g. "evt_<uuid>" — use for idempotency
  event_type: 'message.delivered' | 'message.failed';
  timestamp: string;             // ISO 8601
  tenant_id: string;
  message_id: string;
  metadata?: {
    litedesk_module?: string;
    litedesk_entity_id?: string;
    litedesk_reply_id?: string;
    [key: string]: unknown;
  };
  delivery?: {
    recipient: string;
    smtp_response?: string;
    attempt: number;
    error?: string;
  };
}
```

**Example — delivered:**

```json
{
  "event_id": "evt_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_type": "message.delivered",
  "timestamp": "2026-06-29T10:00:05.000Z",
  "tenant_id": "org_abc123",
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421",
    "litedesk_reply_id": "reply_3"
  },
  "delivery": {
    "recipient": "user@example.com",
    "smtp_response": "250 2.0.0 OK",
    "attempt": 1
  }
}
```

**Example — failed:**

```json
{
  "event_id": "evt_b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "event_type": "message.failed",
  "timestamp": "2026-06-29T10:00:05.000Z",
  "tenant_id": "org_abc123",
  "message_id": "550e8400-e29b-41d4-a716-446655440000",
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421"
  },
  "delivery": {
    "recipient": "user@example.com",
    "attempt": 1,
    "error": "Connection timeout"
  }
}
```

### 4.6 Idempotent event processing

Store processed `event_id` values so AMDS retries do not double-update records.

**MongoDB collection:** `amds_webhook_events`

```javascript
{
  _id: ObjectId,
  event_id: "evt_...",           // unique index
  event_type: "message.delivered",
  message_id: "550e8400-...",
  processed_at: ISODate(),
  payload: { /* full event */ }
}
```

**Index:**

```javascript
db.amds_webhook_events.createIndex({ event_id: 1 }, { unique: true });
// Optional TTL — keep 30 days
db.amds_webhook_events.createIndex({ processed_at: 1 }, { expireAfterSeconds: 2592000 });
```

**Handler logic:**

```typescript
// server/routes/internal/amds-webhook.ts

export async function amdsWebhookHandler(req: Request, res: Response): Promise<void> {
  const event: AmdsWebhookEvent = JSON.parse(req.body.toString('utf8'));

  // 1. Idempotency check
  try {
    await AmdsWebhookEventModel.create({ event_id: event.event_id, ...event });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    throw err;
  }

  // 2. Route by module
  if (event.metadata?.litedesk_module === 'helpdesk') {
    await helpdeskAmdsEventHandler.process(event);
  }

  // 3. Acknowledge quickly
  res.status(200).json({ received: true });
}
```

### 4.7 Event handler (Helpdesk)

```typescript
// server/services/amds/handlers/helpdesk-event-handler.ts

export async function processHelpdeskEvent(event: AmdsWebhookEvent): Promise<void> {
  const ticketId = event.metadata?.litedesk_entity_id;
  const replyId = event.metadata?.litedesk_reply_id;
  if (!ticketId) return;

  const status = event.event_type === 'message.delivered' ? 'delivered' : 'failed';

  const update: Record<string, unknown> = {
    'replies.$[reply].delivery_status': status,
    'replies.$[reply].delivery_updated_at': new Date(event.timestamp),
  };

  if (event.event_type === 'message.failed') {
    update['replies.$[reply].delivery_error'] = event.delivery?.error ?? 'Unknown error';
  }

  await TicketModel.updateOne(
    { _id: ticketId, 'replies.amds_message_id': event.message_id },
    { $set: update },
    { arrayFilters: [{ 'reply.amds_message_id': event.message_id }] }
  );
}
```

---

## 5. Deliverable 3 — Helpdesk integration ✅ Done (LiteDesk)

Implemented via **Communication** model + **Cases** module (`sendCaseReplyEmail.js`). Ticket-reply schema below is the conceptual equivalent.

### 5.1 User flow

1. Agent composes a ticket reply in Helpdesk UI.
2. Agent clicks **Send** (email channel).
3. LiteDesk API creates/stores the reply document.
4. LiteDesk calls `amdsClient.sendMessage()` with ticket context in `metadata`.
5. LiteDesk stores returned `message_id` on the reply (`amds_message_id`).
6. UI shows reply as **Sending…** (`delivery_status: 'queued'`).
7. AMDS worker delivers email → posts webhook.
8. Webhook handler updates reply to **Delivered** or **Failed**.

### 5.2 MongoDB schema changes

**Ticket document** — extend the `replies[]` subdocument:

```javascript
{
  _id: ObjectId("..."),
  org_id: "org_abc123",                    // maps to AMDS tenant_id
  subject: "Login issue",
  requester: { email: "user@example.com", name: "Jane Doe" },
  replies: [
    {
      _id: ObjectId("reply_3"),
      type: "agent",
      channel: "email",
      body_html: "<p>We fixed it...</p>",
      body_text: "We fixed it...",
      agent_id: ObjectId("..."),
      created_at: ISODate(),

      // --- AMDS fields (new) ---
      amds_message_id: "550e8400-e29b-41d4-a716-446655440000",
      delivery_status: "queued",           // queued | processing | delivered | failed
      delivery_error: null,
      delivery_updated_at: ISODate()
    }
  ]
}
```

**Indexes (optional but useful):**

```javascript
db.tickets.createIndex({ "replies.amds_message_id": 1 });
db.tickets.createIndex({ org_id: 1, "replies.delivery_status": 1 });
```

### 5.3 Send flow (service layer)

```typescript
// server/services/helpdesk/send-ticket-reply-email.ts

import { amdsClient } from '../../config/amds.js';
import { TicketModel } from '../../models/ticket.js';

export async function sendTicketReplyEmail(params: {
  ticketId: string;
  replyId: string;
  orgId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  recipientEmail: string;
  recipientName?: string;
}): Promise<{ messageId: string }> {
  const idempotencyKey = `litedesk-helpdesk-${params.orgId}-ticket-${params.ticketId}-reply-${params.replyId}`;

  const response = await amdsClient.sendMessage({
    idempotency_key: idempotencyKey,
    tenant_id: params.orgId,
    from: { email: params.fromEmail, name: params.fromName },
    to: [{ email: params.recipientEmail, name: params.recipientName }],
    subject: params.subject,
    content: { html: params.bodyHtml, text: params.bodyText },
    metadata: {
      litedesk_module: 'helpdesk',
      litedesk_entity_id: params.ticketId,
      litedesk_reply_id: params.replyId,
    },
    tags: ['helpdesk', 'transactional'],
  });

  await TicketModel.updateOne(
    { _id: params.ticketId, 'replies._id': params.replyId },
    {
      $set: {
        'replies.$.amds_message_id': response.message_id,
        'replies.$.delivery_status': 'queued',
        'replies.$.delivery_updated_at': new Date(),
        'replies.$.delivery_error': null,
      },
    }
  );

  return { messageId: response.message_id };
}
```

### 5.4 API route (Helpdesk controller)

Wire into your existing ticket reply endpoint — **after** the reply is persisted, **before** returning to the client:

```typescript
// Pseudocode — adapt to your router (Express/Fastify/Nest)

async function createTicketReply(req, res) {
  const { ticketId } = req.params;
  const { body_html, body_text, send_email } = req.body;
  const orgId = req.user.org_id;

  const ticket = await TicketModel.findById(ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const reply = {
    _id: new ObjectId(),
    type: 'agent',
    channel: send_email ? 'email' : 'internal',
    body_html,
    body_text,
    agent_id: req.user.id,
    created_at: new Date(),
  };

  ticket.replies.push(reply);
  await ticket.save();

  if (send_email && ticket.requester?.email) {
    try {
      await sendTicketReplyEmail({
        ticketId: ticket._id.toString(),
        replyId: reply._id.toString(),
        orgId,
        fromEmail: org.support_email,       // from org settings
        fromName: org.name,
        subject: `Re: ${ticket.subject}`,
        bodyHtml: body_html,
        bodyText: body_text,
        recipientEmail: ticket.requester.email,
        recipientName: ticket.requester.name,
      });
    } catch (err) {
      // Mark reply as failed to send — do not fail the whole reply save
      await TicketModel.updateOne(
        { _id: ticketId, 'replies._id': reply._id },
        {
          $set: {
            'replies.$.delivery_status': 'failed',
            'replies.$.delivery_error': err.message,
          },
        }
      );
    }
  }

  return res.status(201).json({ reply });
}
```

### 5.5 Vue 3 frontend (read-only from LiteDesk API)

Vue **must not** call AMDS directly. Expose delivery fields on the ticket/reply API response:

```typescript
interface TicketReply {
  id: string;
  body_html: string;
  created_at: string;
  amds_message_id?: string;
  delivery_status?: 'queued' | 'processing' | 'delivered' | 'failed';
  delivery_error?: string;
}
```

**UI states:**

| `delivery_status` | Display |
|-------------------|---------|
| `queued` / `processing` | Spinner — "Sending…" |
| `delivered` | Checkmark — "Delivered" |
| `failed` | Error icon — show `delivery_error`, offer retry |

**Polling fallback:** If status stays `queued` > 30s, poll LiteDesk API which can call `amdsClient.getMessageStatus(message_id)` server-side.

---

## 6. End-to-end sequence

```
Agent          LiteDesk API       MongoDB        AMDS Gateway     AMDS Worker      Mailpit
  │                 │                │                │                │              │
  │ POST reply      │                │                │                │              │
  ├────────────────►│                │                │                │              │
  │                 │ save reply     │                │                │              │
  │                 ├───────────────►│                │                │              │
  │                 │ POST /v1/messages               │                │              │
  │                 ├────────────────────────────────►│                │              │
  │                 │◄──────────────── 202 message_id │                │              │
  │                 │ update reply   │                │                │              │
  │                 ├───────────────►│                │                │              │
  │◄────────────────┤ 201 + reply    │                │                │              │
  │                 │                │                │ dequeue job    │              │
  │                 │                │                ├───────────────►│              │
  │                 │                │                │                │ SMTP send    │
  │                 │                │                │                ├─────────────►│
  │                 │ POST /webhooks/amds             │                │              │
  │                 │◄─────────────────────────────────────────────────┤              │
  │                 │ update delivery_status          │                │              │
  │                 ├───────────────►│                │                │              │
```

---

## 7. Local development checklist

### Prerequisites

- AMDS repo running: `npm run setup && npm run dev`
- LiteDesk API on `http://localhost:3000`
- Mailpit UI: `http://localhost:8025`

### LiteDesk tasks

- [x] Add env vars (`AMDS_BASE_URL`, `AMDS_API_KEY`, `AMDS_WEBHOOK_SECRET`)
- [x] Implement `AmdsClient` + singleton
- [x] Implement webhook route with signature verification + raw body
- [x] Create `amds_webhook_events` collection with unique index on `event_id`
- [x] Wire AMDS into CRM + helpdesk outbound (`POST /api/communications/email`) via Communication model
- [x] AMDS provider in Settings → Integrations → Email
- [x] Expose delivery state on Communication + case timeline (`deliveryStatus`, `amdsMessageId`)
- [x] Helpdesk webhook handler updates Case activity on AMDS delivery events
- [x] `sendCaseReplyEmail` contract documented — case sends use Communication + `moduleKey: cases`

### Validation tests

- [x] Send email → `202` from AMDS → `amds_message_id` stored on Communication
- [x] Email appears in Mailpit within ~5 seconds
- [x] Webhook received → status becomes `delivered`
- [x] Duplicate send (same idempotency key) → same `message_id`, no duplicate email (`npm run validate:phase-0a`)
- [x] Invalid signature on webhook → `401`
- [x] Replay same webhook `event_id` → idempotent (no double update)
- [x] Stop LiteDesk briefly, send email, restart → poll `GET /api/communications/:id/delivery-status` recovers status

### Manual webhook test (without waiting for AMDS)

```bash
# Generate signature (Node REPL)
node -e "
const crypto = require('crypto');
const secret = 'dev_webhook_secret';
const ts = Math.floor(Date.now()/1000).toString();
const body = JSON.stringify({
  event_id: 'evt_test_manual_1',
  event_type: 'message.delivered',
  timestamp: new Date().toISOString(),
  tenant_id: 'org_local',
  message_id: '<paste amds_message_id here>',
  metadata: { litedesk_module: 'helpdesk', litedesk_entity_id: '<ticketId>', litedesk_reply_id: '<replyId>' },
  delivery: { recipient: 'user@example.com', smtp_response: '250 OK', attempt: 1 }
});
const sig = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
console.log('Timestamp:', ts);
console.log('Signature:', sig);
console.log('Body:', body);
"

curl -X POST http://localhost:3000/api/internal/webhooks/amds \
  -H "Content-Type: application/json" \
  -H "X-AMDS-Timestamp: <timestamp>" \
  -H "X-AMDS-Signature: <signature>" \
  -d '<body>'
```

---

## 8. Production notes

| Topic | Guidance |
|-------|----------|
| **Network** | LiteDesk → AMDS over private VCN IP; block `/v1/*` from public internet |
| **TLS** | Use HTTPS even on private network (self-signed OK in Phase 0–1) |
| **Secrets** | Rotate `AMDS_API_KEY` and `AMDS_WEBHOOK_SECRET` quarterly |
| **Webhook URL** | Set AMDS `LITEDESK_WEBHOOK_URL` to LiteDesk private endpoint |
| **From address** | Use org's verified support email once domain verification lands (Phase 2) |
| **Monitoring** | Log AMDS errors; alert on high `delivery_status: failed` rate |

---

## 9. Future phases (not in scope yet)

Do not implement these until AMDS exposes the corresponding APIs/events:

| Feature | AMDS phase |
|---------|------------|
| `message.bounced` / `message.complained` webhooks | Phase 2 |
| Domain verification (SPF/DKIM/DMARC) | Phase 2 |
| Campaign / marketing bulk send | Phase 3 |
| Open/click tracking events | Phase 3 |
| Template rendering via AMDS (`template_id`) | Phase 2+ |

For Phase 0a–1, LiteDesk always sends pre-rendered `content.html` + `content.text`.

---

## 10. File checklist (LiteDesk repo)

| File / area | Purpose | Status |
|-------------|---------|--------|
| `AmdsClient` + env config | HTTP client, singleton | Done |
| Webhook route (`/api/internal/webhooks/amds`) | HMAC verification, event intake | Done |
| `amds_webhook_events` model / collection | Idempotency on `event_id` | Done |
| Communication model + AMDS metadata | `amdsMessageId`, delivery status | Done |
| `sendCaseReplyEmail.js` | Cases / helpdesk outbound send | Done |
| Settings → Integrations → Email | AMDS provider selection | Done |
| Case timeline / threads UI | `deliveryStatus` display | Done |
| `GET /api/communications/:id/delivery-status` | Poll fallback when webhook delayed | Done |

Reference implementations from the original spec (ticket `replies[]` pattern — not the primary LiteDesk path):

| File | Purpose |
|------|---------|
| `server/services/amds/amds-types.ts` | Shared TypeScript interfaces |
| `server/services/amds/amds-client.ts` | HTTP client |
| `server/config/amds.ts` | Env + singleton |
| `server/middleware/verify-amds-signature.ts` | Webhook HMAC verification |
| `server/routes/internal/amds-webhook.ts` | Webhook endpoint |
| `server/services/amds/handlers/helpdesk-event-handler.ts` | Delivery event → entity update |
| `server/services/helpdesk/send-ticket-reply-email.ts` | Alternative: send on ticket reply |
| `server/models/amds-webhook-event.ts` | Idempotency store |

---

*Maintained in the AMDS repo at `docs/LITEDESK-INTEGRATION.md`. Update when AMDS API or webhook contract changes.*
