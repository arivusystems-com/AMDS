# AMDS (Arivu Mail Delivery System) — End-to-End Roadmap

**Version:** 1.1  
**Date:** June 29, 2026  
**Status:** Planning  
**Related systems:** LiteDesk (business layer) · VMDS/AMDS (delivery layer) · OCI Compute  
**LiteDesk stack:** Node.js · Vue 3 · MongoDB  
**Network decision:** Same OCI VCN, separate subnets (see §4.2)

---

## 1. Executive Summary

AMDS is a standalone outbound email infrastructure platform — functionally comparable to **Amazon SES**, **OCI Email Delivery**, **SendGrid**, and **Mailgun** — purpose-built for the LiteDesk ecosystem.

| Layer | Responsibility |
|-------|----------------|
| **LiteDesk** | CRM, Helpdesk, Marketing, Automation, Billing, Portal — decides *what* to send, *when*, and *to whom* |
| **AMDS** | Message gateway, queues, SMTP delivery, tracking, bounces, domain auth, analytics — decides *how* it is delivered |

This document is the end-to-end roadmap: architecture, OCI deployment topology, LiteDesk integration, phased delivery plan, and success criteria. Implementation follows approval of this plan.

---

## 2. Design Principles (from Platform Architecture)

These principles govern every implementation decision:

1. **Single Responsibility** — AMDS does email delivery only; no CRM, contacts, or business workflows
2. **API First** — Every capability exposed via versioned REST API (future: SMTP submission)
3. **Queue Driven** — All outbound mail flows through durable queues before delivery
4. **Event Driven** — Delivery, bounce, open, click events propagate back to LiteDesk via webhooks
5. **Stateless Workers** — Horizontal scale; workers never talk to each other
6. **Horizontal Scalability** — Worker Orchestrator scales capacity with queue depth
7. **Independent Deployment** — AMDS deploys, upgrades, and scales separately from LiteDesk
8. **High Availability** — No single point of failure in queue, workers, or gateway
9. **Security by Design** — mTLS/API keys, tenant isolation, signed webhooks
10. **Zero Vendor Lock-in** — Self-hosted on OCI; portable stack (Postfix/Haraka, Redis/RabbitMQ, PostgreSQL)

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  OCI Compute #1 — LiteDesk                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │   CRM    │ │ Helpdesk │ │ Marketing│ │Automation│ │  Portal  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       └────────────┴────────────┴────────────┴────────────┘           │
│                              │                                          │
│                    LiteDesk Email Service (SDK/HTTP client)             │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │ HTTPS (private VCN or public + IP allowlist)
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  OCI Compute #2 — AMDS (VMDS)                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Message Gateway          ← POST /v1/messages, domain APIs         │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │ Queue Manager            ← Transaction / Campaign / Scheduled /  │  │
│  │                            Retry / Dead Letter queues             │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │ Worker Orchestrator      ← Auto-scale stateless workers           │  │
│  ├──────────────────────────────────────────────────────────────────┤  │
│  │ Delivery Engine            ← MX lookup, SMTP, retries             │  │
│  │ Template Rendering Engine  ← Merge vars → HTML + plain text       │  │
│  │ Domain Management          ← SPF / DKIM / DMARC / DNS verify      │  │
│  │ Tracking Engine            ← Opens, clicks, redirect service      │  │
│  │ Bounce & Complaint Proc.   ← FBL, suppression lists               │  │
│  │ Analytics Engine           ← Rates, queue/SMTP metrics            │  │
│  │ Monitoring & Observability ← Health, alerts, logs                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │ SMTP (port 25/587) + DNS
                               ▼
                    Internet → Recipient Mail Servers (Gmail, Outlook, etc.)
```

---

## 4. OCI Deployment Topology

### 4.1 Two-Compute Model (Current Plan)

| Resource | LiteDesk Compute | AMDS Compute |
|----------|------------------|--------------|
| **Role** | Business API + UI | Email delivery platform |
| **Outbound to AMDS** | HTTPS client → AMDS Gateway | Receives API requests |
| **Inbound from AMDS** | Webhook endpoint for events | POST delivery/bounce/open/click events |
| **Public IP** | Optional (UI/API) | Required for SMTP egress; API can be private |
| **DNS** | `app.litedesk.example.com` | `mail-api.amds.example.com`, `track.amds.example.com`, `bounce.amds.example.com` |

### 4.2 Recommended OCI Networking — **Use the Same VCN**

**Recommendation: Host LiteDesk and AMDS in the same OCI VCN, on separate subnets.**

Same-VCN is the right default for your setup (two OCI Compute instances, single region, tight service coupling). It gives you private IP communication, simpler security lists, lower latency, and no peering cost — while still keeping **independent deployment** (separate VMs, separate deploy pipelines, separate databases).

| Approach | Verdict | Why |
|----------|---------|-----|
| **Same VCN, separate subnets** | **Recommended** | Private API traffic, minimal cost, simple ops |
| Separate VCNs + Local Peering | Only if org policy requires it | Extra peering, routing, and ACL complexity with no deliverability benefit |
| Public API + IP allowlist | Dev/MVP fallback only | Exposes mail API to internet unnecessarily |

**Do not merge into one Compute instance.** LiteDesk (Node.js + Vue 3 + MongoDB) and AMDS (Node.js + PostgreSQL + Redis + SMTP) should stay on **separate VMs** within the same VCN so email worker load never starves LiteDesk API/UI, and you can scale/restart AMDS without touching LiteDesk.

#### Target layout

```
OCI VCN — litedesk-prod-vcn (10.0.0.0/16)
│
├── Public Subnet — 10.0.1.0/24
│   ├── OCI Load Balancer → LiteDesk (Vue 3 SPA + Node API)
│   └── AMDS public-facing endpoints only:
│       ├── track.yourdomain.com   (open/click redirects — must be public)
│       └── bounce.yourdomain.com  (inbound bounce SMTP — Phase 2)
│
├── Private Subnet — 10.0.2.0/24  ← primary integration path
│   ├── LiteDesk Compute (Node.js API, MongoDB co-located or OCI-managed)
│   │     private IP e.g. 10.0.2.10
│   └── AMDS Compute (Message Gateway + workers)
│         private IP e.g. 10.0.2.20
│         LiteDesk calls: https://10.0.2.20:8080  (or internal DNS amds.internal)
│
└── Data Subnet — 10.0.3.0/24 (optional, or co-locate on AMDS VM in Phase 0)
    ├── PostgreSQL (AMDS — messages, domains, events)
    └── Redis (AMDS — queues, idempotency, rate limits)

Note: LiteDesk keeps MongoDB (contacts, tickets, campaigns).
      AMDS keeps PostgreSQL (delivery state only). No shared database.
```

#### Traffic rules (OCI Security Lists / NSGs)

| Source | Destination | Ports | Purpose |
|--------|-------------|-------|---------|
| LiteDesk private IP | AMDS private IP | 8080 (or 443) | `POST /v1/messages`, status polls |
| AMDS private IP | LiteDesk private IP | 3000/443 (your Node port) | Webhook `POST /api/internal/webhooks/amds` |
| AMDS | Internet | 25, 587, 53 | SMTP delivery + DNS (MX lookup) |
| Internet | AMDS public IP | 443 | Tracking redirects only (Phase 3) |
| Internet | AMDS public IP | 25 | Inbound bounces (Phase 2) |
| Admin/VPN | Both private IPs | 22 | SSH (restrict to your IP) |

**Block:** AMDS Message Gateway API (`/v1/*`) from the public internet. Only LiteDesk's private IP should reach it.

#### Internal DNS (recommended)

Create a private DNS zone in OCI so LiteDesk config survives IP changes:

| Record | Points to |
|--------|-----------|
| `amds.internal` | AMDS private IP (10.0.2.20) |
| `litedesk.internal` | LiteDesk private IP (10.0.2.10) |

LiteDesk env: `AMDS_BASE_URL=https://amds.internal:8080`

#### TLS on private network

Even on private IPs, use TLS between LiteDesk and AMDS:

- **Phase 0–1:** Self-signed cert on AMDS; LiteDesk trusts via CA bundle in env
- **Phase 2+:** Internal cert from OCI Certificates or Let's Encrypt on internal name

#### When to use a separate VCN later

Move AMDS to its own VCN (with Local Peering) only if:

- A compliance team mandates network isolation for mail infrastructure
- AMDS serves multiple products beyond LiteDesk
- You need a dedicated DMZ for SMTP ingress/egress

For Phase 0–4, same VCN is sufficient and simpler.

#### OCI SMTP note

Request **outbound port 25 unblock** on the AMDS compute/subnet early (OCI blocks it by default). Without it, AMDS cannot deliver mail directly. Apply via OCI support before Phase 1 SMTP testing.

### 4.3 DNS & Deliverability (Critical Path)

AMDS must own these DNS records (per verified sending domain):

| Record | Purpose |
|--------|---------|
| **SPF** | `v=spf1 include:amds.example.com ~all` |
| **DKIM** | RSA/Ed25519 selector per domain (`selector._domainkey.customer.com`) |
| **DMARC** | `v=DMARC1; p=quarantine; rua=mailto:dmarc@amds.example.com` |
| **MX (bounce)** | Bounce handler subdomain |
| **CNAME (tracking)** | `track.customer.com` → AMDS tracking endpoint |

**OCI-specific:** Request reverse DNS (PTR) for AMDS egress IP — essential for inbox placement. Warm up new IPs gradually (see Phase 4).

### 4.4 Local-First Development (Before OCI Deploy)

**Yes — build and validate almost everything locally first.** Cloud deployment is a migration step, not a prerequisite for development. OCI networking, port 25 unblock, and PTR records only matter when you go live with real recipient inboxes.

#### What runs locally vs what needs cloud

| Capability | Local | Cloud-only (later) |
|------------|-------|---------------------|
| Message Gateway API | ✅ `localhost:8080` | — |
| Queue + workers | ✅ Redis in Docker | — |
| LiteDesk → AMDS integration | ✅ both on localhost | — |
| AMDS → LiteDesk webhooks | ✅ `localhost:3000` | — |
| SMTP delivery | ✅ **Mailpit** catches all mail | Real delivery to Gmail/Outlook |
| Idempotency, auth, rate limits | ✅ | — |
| PostgreSQL persistence | ✅ Docker | OCI DB when deployed |
| Open/click tracking | ✅ `localhost:8080/t/...` | Public `track.*` DNS |
| Bounce parsing | ✅ Simulate with test scripts | Inbound SMTP from ISPs |
| DKIM signing | ✅ Test keys in `.env` | OCI Vault in production |
| Domain DNS verification | ✅ Mock or manual | Live DNS checks |
| IP reputation / warm-up | ❌ skip locally | OCI egress IP + PTR |
| Vue 3 UI | ✅ LiteDesk dev server | — |
| MongoDB (LiteDesk) | ✅ local or Docker | OCI when deployed |

#### Local architecture

```
Your Mac / dev machine
├── Docker Compose
│   ├── PostgreSQL :5432   (AMDS)
│   ├── Redis      :6379   (AMDS queues)
│   └── Mailpit    :8025 UI, :1025 SMTP  (catches all outbound mail)
│
├── AMDS (VMDS repo) — npm run dev
│   ├── Gateway  → http://localhost:8080
│   └── Worker   → delivers to Mailpit SMTP (not port 25)
│
└── LiteDesk (separate repo) — npm run dev
    ├── Node API → http://localhost:3000
    ├── Vue 3    → http://localhost:5173
    ├── MongoDB  → localhost:27017 (local or Docker)
    └── AmdsClient → AMDS_BASE_URL=http://localhost:8080
```

#### Local workflow (daily dev loop)

```bash
# Terminal 1 — AMDS infrastructure
cd VMDS && docker compose up -d

# Terminal 2 — AMDS gateway + worker
cd VMDS && npm run dev

# Terminal 3 — LiteDesk
cd LiteDesk && npm run dev

# Send a test email from Helpdesk → open Mailpit UI
open http://localhost:8025
```

#### Environment mapping (local → OCI)

| Local | OCI Production |
|-------|----------------|
| `http://localhost:8080` | `https://amds.internal:8080` (private) |
| `http://localhost:3000` | LiteDesk Node API (private IP or LB) |
| Mailpit `:1025` | Real SMTP `:25` egress |
| `.env` file secrets | OCI Vault |
| `docker compose` Postgres/Redis | OCI Compute or managed services |
| `mkcert` or HTTP (dev) | TLS certs on private network |

#### What to validate locally before first OCI deploy

- [x] `POST /v1/messages` accepts payload and returns `202`
- [x] Worker picks up queue job and Mailpit shows the email
- [x] LiteDesk CRM/case email triggers send and stores `amds_message_id` on Communication
- [x] AMDS webhook updates delivery status in MongoDB
- [x] Idempotency: duplicate send returns same `message_id`
- [x] Invalid auth rejected by gateway (`401`)
- [x] Automated check: `npm run validate:phase-0a`

See [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md) for full exit record.

#### First OCI deploy (when local checklist passes)

Only then provision OCI: VCN, Compute, security lists, port 25 unblock. Change env URLs from `localhost` to private IPs — **no application code changes** if config is env-driven.

See `docker-compose.yml` in the VMDS repo root for local Postgres, Redis, and Mailpit.

---

## 5. LiteDesk ↔ AMDS Integration

### 5.1 Integration Philosophy

> **LiteDesk decides what should be sent. AMDS decides how it is delivered.**

LiteDesk never opens SMTP connections to the internet. It sends structured **send requests** to AMDS and consumes **events** asynchronously.

### 5.1 Integration Flow

```
LiteDesk                          AMDS                           Recipient
   │                                │                                │
   │  1. POST /v1/messages          │                                │
   │  (template_id, vars, to, etc.) │                                │
   ├───────────────────────────────►│                                │
   │  2. 202 Accepted               │                                │
   │  { message_id, status:queued } │                                │
   │◄───────────────────────────────┤                                │
   │                                │  3. Queue → Worker → SMTP      │
   │                                ├───────────────────────────────►│
   │                                │                                │
   │  4. POST /webhooks/amds        │  5. delivery / bounce / open   │
   │◄───────────────────────────────┤                                │
   │                                │                                │
```

### 5.2 Authentication Between Services

| Direction | Method | Details |
|-----------|--------|---------|
| LiteDesk → AMDS | **API Key + HMAC** or **OAuth2 client credentials** | Header: `Authorization: Bearer <token>` or `X-AMDS-Key` + `X-AMDS-Signature` |
| AMDS → LiteDesk | **Signed webhooks** | HMAC-SHA256 over payload + timestamp; reject if `X-AMDS-Timestamp` > 5 min old |
| Transport | **TLS 1.3** | Private VCN preferred; cert pinning optional |

**Tenant model:** Each LiteDesk organization maps to an AMDS `tenant_id`. All requests scoped by tenant; suppression lists and domains are tenant-isolated.

### 5.3 LiteDesk Stack & Client SDK

**LiteDesk stack (confirmed):**

| Component | Technology | AMDS interaction |
|-----------|------------|------------------|
| API | Node.js (Express/Fastify/Nest — match your existing app) | HTTP client → AMDS Gateway |
| Frontend | Vue 3 | No direct AMDS calls; UI reads delivery status from LiteDesk API |
| Database | MongoDB | Stores `message_id`, ticket/campaign correlation, webhook event log |
| AMDS data | — | PostgreSQL on AMDS side only (delivery pipeline state) |

Vue 3 never talks to AMDS directly. Node.js backend owns all AMDS communication. MongoDB stores correlation fields (`amds_message_id`, `delivery_status`) on tickets, campaigns, and contacts.

#### Node.js SDK (build inside LiteDesk repo)

Suggested path: `server/services/amds/` (or your existing services layout).

```typescript
// server/services/amds/amds-client.ts — implement in LiteDesk repo
import axios, { AxiosInstance } from 'axios';

export class AmdsClient {
  private http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10_000,
    });
  }

  async sendTransactional(params: SendMessageRequest): Promise<SendMessageResponse> {
    const { data } = await this.http.post('/v1/messages', params);
    return data;
  }

  async getMessageStatus(messageId: string): Promise<MessageStatus> {
    const { data } = await this.http.get(`/v1/messages/${messageId}`);
    return data;
  }

  // Phase 2+: scheduleMessage, verifyDomain, listSuppressions, sendCampaignBatch
}
```

Register as a singleton in your Node app:

```typescript
// server/config/amds.ts
export const amdsClient = new AmdsClient(
  process.env.AMDS_BASE_URL!,   // https://amds.internal:8080
  process.env.AMDS_API_KEY!
);
```

#### Webhook handler (Node.js route in LiteDesk)

```typescript
// server/routes/internal/amds-webhook.ts
router.post('/api/internal/webhooks/amds', verifyAmdsSignature, async (req, res) => {
  const event = req.body;
  await amdsEventHandler.process(event);  // idempotent on event.event_id
  res.status(200).json({ received: true });
});
```

Store processed `event_id` values in MongoDB (TTL index) to guarantee idempotent webhook handling.

LiteDesk modules that integrate:

| LiteDesk Module | AMDS Queue | Priority |
|-----------------|------------|----------|
| Helpdesk (ticket replies) | Transaction | P0 |
| CRM (notifications) | Transaction | P0 |
| Automation (workflows) | Transaction / Scheduled | P0 |
| Marketing (campaigns) | Campaign | P1 |
| Billing (invoices, receipts) | Transaction | P0 |
| Portal (password reset, alerts) | Transaction | P0 |

### 5.4 Message Payload Contract

**Request: `POST /v1/messages`**

```json
{
  "idempotency_key": "litedesk-helpdesk-ticket-88421-reply-1",
  "tenant_id": "org_abc123",
  "from": { "email": "support@customer.com", "name": "Acme Support" },
  "reply_to": { "email": "support@customer.com" },
  "to": [{ "email": "user@example.com", "name": "Jane Doe" }],
  "cc": [],
  "bcc": [],
  "subject": "Re: Your ticket #88421",
  "template": {
    "template_id": "helpdesk-reply-v2",
    "variables": {
      "ticket_id": "88421",
      "agent_name": "Alex",
      "body_html": "<p>We resolved your issue...</p>"
    }
  },
  "tags": ["helpdesk", "transactional"],
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421"
  },
  "tracking": {
    "opens": true,
    "clicks": true
  },
  "scheduled_at": null
}
```

**Alternative: pre-rendered content** (LiteDesk renders locally):

```json
{
  "content": {
    "html": "<html>...</html>",
    "text": "Plain text fallback"
  }
}
```

**Response: `202 Accepted`**

```json
{
  "message_id": "msg_01HXYZ...",
  "status": "queued",
  "queue": "transaction",
  "created_at": "2026-06-29T10:00:00Z"
}
```

### 5.5 Webhook Events (AMDS → LiteDesk)

**Endpoint on LiteDesk:** `POST /api/internal/webhooks/amds`

| Event Type | When | LiteDesk Action |
|------------|------|-----------------|
| `message.delivered` | SMTP 250 OK | Update ticket/campaign status |
| `message.bounced` | Hard/soft bounce | Suppress address, notify agent |
| `message.complained` | Spam complaint | Suppress, alert compliance |
| `message.opened` | Tracking pixel | Marketing analytics |
| `message.clicked` | Link redirect | Marketing analytics |
| `message.failed` | Permanent failure | Retry logic in LiteDesk UI |

**Event payload example:**

```json
{
  "event_id": "evt_01H...",
  "event_type": "message.delivered",
  "timestamp": "2026-06-29T10:00:05Z",
  "tenant_id": "org_abc123",
  "message_id": "msg_01HXYZ...",
  "metadata": {
    "litedesk_module": "helpdesk",
    "litedesk_entity_id": "ticket_88421"
  },
  "delivery": {
    "recipient": "user@example.com",
    "smtp_response": "250 2.0.0 OK",
    "attempt": 1
  }
}
```

### 5.6 Idempotency & Reliability

- LiteDesk sends `idempotency_key` on every request; AMDS deduplicates for 24h
- LiteDesk retries on `5xx` with exponential backoff (max 3 attempts)
- AMDS webhooks retry to LiteDesk on failure (exponential backoff, 72h window)
- LiteDesk webhook handler must be **idempotent** on `event_id`

---

## 6. AMDS Internal Component Design

### 6.1 Message Gateway

| Responsibility | Implementation Notes |
|----------------|---------------------|
| Single entry point | Node.js/Go API behind nginx or OCI Load Balancer |
| Validation | JSON schema, recipient limits, attachment size |
| Sender validation | Domain must be verified for tenant |
| Idempotency | Redis/PostgreSQL dedup store |
| Rate limiting | Per-tenant token bucket |
| Routing | Transaction vs Campaign vs Scheduled queue |

### 6.2 Queue Manager

| Queue | Use Case | Priority | SLA Target |
|-------|----------|----------|------------|
| **Transaction** | Helpdesk, billing, auth emails | Highest | < 30s p95 |
| **Campaign** | Marketing bulk | Normal | Throughput-optimized |
| **Scheduled** | Future-dated sends | Time-triggered | ± 1 min |
| **Retry** | Temporary SMTP failures | Escalating | Exponential backoff |
| **Dead Letter** | Permanent failures | Manual review | Alert on insert |

**Recommended stack:** Redis Streams or RabbitMQ (Phase 1); consider Apache Pulsar/Kafka at scale.

### 6.3 Worker Orchestrator

- Polls queue depth metrics every N seconds
- Scales worker processes/containers: `min_workers` → `max_workers`
- Health checks: heartbeat + processing latency
- Campaign bursts → auto-scale; idle → scale to zero (or min)

### 6.4 Delivery Engine

- Resolve MX via DNS (cached)
- SMTP connection pooling per destination domain
- TLS required when recipient supports STARTTLS
- Retry policy: soft bounces → Retry queue (max 6 attempts over 24h)
- Connection/concurrency limits per domain (avoid throttling)

**SMTP stack options:**

| Option | Notes |
|--------|-------|
| **Haraka** (Node.js) | Plugin ecosystem, good for custom tracking injection |
| **Postfix** | Battle-tested; AMDS workers submit to local Postfix |
| **Custom Go SMTP client** | Maximum control; more engineering effort |

### 6.5 Template Rendering Engine

- Receives `template_id` + `variables` from LiteDesk
- Fetches template definition from AMDS cache (synced from LiteDesk) **or** LiteDesk sends pre-rendered HTML
- **Phase 1 recommendation:** LiteDesk pre-renders; AMDS accepts `content.html` + `content.text`
- **Phase 2:** AMDS pulls templates from LiteDesk Template API on cache miss

### 6.6 Domain Management

API surface:

- `POST /v1/domains` — Register sending domain
- `GET /v1/domains/{domain}/dns-records` — Return required SPF/DKIM/DMARC records
- `POST /v1/domains/{domain}/verify` — DNS lookup validation
- `GET /v1/domains/{domain}/health` — Reputation / auth status

Store DKIM private keys in **OCI Vault** (never in code or plain env vars).

### 6.7 Tracking Engine

- **Open tracking:** 1×1 pixel `GET /t/{token}.png`
- **Click tracking:** `GET /c/{token}` → 302 to original URL
- Tokens: HMAC-signed, tenant-scoped, no PII in URL

### 6.8 Bounce & Complaint Processing

- Inbound SMTP on `bounce.amds.example.com` (Verp/envelope sender)
- Parse DSN (Delivery Status Notification) → classify hard/soft
- Register for ISP feedback loops (Yahoo, Microsoft SNDS, etc.)
- Auto-add to tenant suppression list on hard bounce + complaint

### 6.9 Analytics Engine

Metrics (Prometheus + Grafana or OCI Monitoring):

- Delivery rate, open rate, click rate, bounce rate, complaint rate
- Queue depth, worker count, SMTP latency, deferral rate
- Per-tenant dashboards via API: `GET /v1/analytics/summary`

### 6.10 Monitoring & Observability

| Signal | Tool |
|--------|------|
| Logs | Structured JSON → OCI Logging / Loki |
| Metrics | Prometheus → Grafana |
| Traces | OpenTelemetry (gateway → queue → worker → SMTP) |
| Alerts | PagerDuty/OCI Notifications: queue depth, bounce spike, worker crash |
| Health | `GET /health`, `GET /ready` (DB + queue connectivity) |

---

## 7. Data Model (Core Entities)

```
Tenant
  └── Domain (SPF/DKIM/DMARC status)
  └── SuppressionList (email, reason, created_at)
  └── ApiKey

Message
  └── message_id, tenant_id, status, queue, idempotency_key
  └── recipients[], content, metadata, tags
  └── DeliveryAttempt[] (timestamp, smtp_code, response)
  └── Events[] (delivered, bounced, opened, clicked)

Campaign (Phase 3)
  └── batch_id, messages[], schedule, stats
```

**Primary store:** PostgreSQL  
**Hot queue:** Redis / RabbitMQ  
**Blob storage:** OCI Object Storage (large attachments, MIME archives)

---

## 8. Feature Parity vs SES / OCI Email Delivery

| Capability | SES / OCI Email | AMDS Target Phase |
|------------|-----------------|-------------------|
| Transactional send API | ✅ | Phase 1 |
| Bulk / campaign send | ✅ | Phase 3 |
| Domain verification (SPF/DKIM/DMARC) | ✅ | Phase 2 |
| Bounce & complaint handling | ✅ | Phase 2 |
| Suppression lists | ✅ | Phase 2 |
| Open/click tracking | ✅ (config) | Phase 3 |
| Scheduled send | ✅ | Phase 2 |
| Dedicated IP / warm-up | ✅ | Phase 4 |
| SMTP relay submission | ✅ | Phase 4 |
| Event webhooks (SNS equivalent) | ✅ | Phase 1 |
| IAM / API keys per tenant | ✅ | Phase 1 |
| Sending statistics | ✅ | Phase 3 |
| Template management | ✅ (SES) / external | LiteDesk-owned |
| Multi-region | ✅ | Phase 5 |

---

## 9. Technology Stack Recommendation

| Layer | Recommendation | Rationale |
|-------|----------------|-----------|
| **API Gateway** | Node.js (Fastify) | Matches LiteDesk stack; shared TypeScript types possible |
| **Workers** | Node.js (same monorepo) | Shared models with gateway; Haraka is Node-native |
| **Queue** | Redis Streams → RabbitMQ | Simple start; proven at scale |
| **Database** | PostgreSQL 16 | ACID, JSONB for metadata |
| **Cache** | Redis | Idempotency, rate limits, DNS cache |
| **SMTP** | Haraka or Postfix relay | Deliverability track record |
| **Secrets** | OCI Vault | DKIM keys, API secrets |
| **Container** | Docker + systemd (Phase 1) → OKE (Phase 4) | Match team maturity |
| **Reverse proxy** | nginx / Caddy | TLS termination, rate limit |

---

## 10. Phased Implementation Roadmap

### Phase 0 — Foundation (Weeks 1–2)

**Goal:** Repo structure, local dev environment, end-to-end proof on localhost — then OCI baseline.

#### Phase 0a — Local (do this first)

| Task | Deliverable |
|------|-------------|
| Initialize VMDS monorepo | `services/gateway`, `services/worker`, `packages/shared` |
| `docker compose up` | PostgreSQL + Redis + Mailpit running locally |
| Gateway `/health`, `/ready` | Responds with DB + Redis connectivity |
| PostgreSQL schema v1 | Migrations run against local Docker Postgres |
| Worker → Mailpit | Test email visible at `http://localhost:8025` |
| LiteDesk `AmdsClient` | Points to `http://localhost:8080` |
| Webhook route in LiteDesk | Delivery event updates MongoDB ticket |
| CI pipeline | Lint, test, build on every push |

**Exit criteria (local):** LiteDesk outbound email → AMDS → Mailpit → webhook → `delivered` on Communication — all on localhost. **Complete** — see [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md).

#### Phase 0b — OCI (after local exit criteria pass)

| Task | Deliverable |
|------|-------------|
| Provision VCN + Compute | AMDS VM in private subnet |
| Deploy same stack to OCI | Env vars only change (URLs, secrets) |
| Request port 25 unblock | Required before real SMTP test |
| Network proof | LiteDesk compute → AMDS `/health` over private IP |
| One real inbox test | Send to Gmail/Outlook from OCI |

**Exit criteria (cloud):** Same flow as local, but email arrives in a real inbox.

---

### Phase 1 — MVP Transactional Pipeline (Weeks 3–6)

**Goal:** LiteDesk sends one email; AMDS queues, delivers via SMTP, webhook confirms delivery.

| Task | Deliverable |
|------|-------------|
| Message Gateway API | `POST /v1/messages`, `GET /v1/messages/{id}` |
| API key auth | Per-tenant keys, rate limiting |
| Idempotency | Dedup by `idempotency_key` |
| Transaction queue + worker | End-to-end single message flow |
| Delivery Engine v1 | MX lookup, SMTP send, status update |
| Webhooks v1 | `message.delivered`, `message.failed` → LiteDesk |
| LiteDesk SDK v1 | `sendTransactional()` in Helpdesk module |
| Observability baseline | Structured logs, `/health`, `/ready` |

**Exit criteria:** Helpdesk ticket reply email delivered to Gmail/Outlook test accounts; webhook received in LiteDesk.

---

### Phase 2 — Domain Auth, Bounces, Scheduling (Weeks 7–10)

**Goal:** Production-grade sender identity and failure handling.

| Task | Deliverable |
|------|-------------|
| Domain Management API | Register, verify, DNS record generation |
| DKIM signing | OCI Vault key storage, per-domain selectors |
| SPF/DMARC validation | Automated DNS checks |
| Bounce handler | Inbound SMTP, DSN parsing, suppression |
| Retry queue | Soft bounce exponential backoff |
| Dead letter queue | Admin API to inspect/replay |
| Scheduled queue | `scheduled_at` support |
| Webhooks v2 | `message.bounced`, `message.complained` |
| LiteDesk integration | CRM notifications, billing receipts |

**Exit criteria:** Customer domain verified; hard bounce auto-suppresses; DMARC passes on mail-tester.com.

---

### Phase 3 — Campaigns, Tracking, Analytics (Weeks 11–14)

**Goal:** Marketing module support and operational dashboards.

| Task | Deliverable |
|------|-------------|
| Campaign queue | Batch ingest API `POST /v1/campaigns/{id}/messages` |
| Worker auto-scaling | Orchestrator scales on campaign queue depth |
| Open/click tracking | Pixel + redirect service |
| Analytics API | Summary endpoints per tenant |
| Grafana dashboards | Queue, SMTP, delivery rates |
| LiteDesk Marketing integration | Campaign send + stats UI |
| Template sync (optional) | Pull templates from LiteDesk API |

**Exit criteria:** 10K recipient campaign completes with tracking events; dashboard shows delivery funnel.

---

### Phase 4 — Production Hardening (Weeks 15–18)

**Goal:** SES-class reliability and deliverability.

| Task | Deliverable |
|------|-------------|
| IP warm-up program | Automated ramp schedules per new IP |
| Dedicated IP pools | Transaction vs marketing separation |
| SMTP submission (587) | Authenticated relay for external clients |
| Multi-worker HA | Active-active workers, graceful shutdown |
| OCI Load Balancer | Gateway HA |
| Backup & DR | PostgreSQL backups, queue persistence policy |
| Penetration test | API auth, webhook signature validation |
| Runbooks | Incident response, bounce spike, IP blocklist |

**Exit criteria:** 99.9% gateway uptime over 30 days; complaint rate < 0.1%.

---

### Phase 5 — Scale & Multi-Region (Weeks 19+)

**Goal:** Enterprise scale, optional second OCI region.

| Task | Deliverable |
|------|-------------|
| OKE migration | Kubernetes deployment |
| Read replicas | PostgreSQL read scaling for analytics |
| Multi-region gateway | Route 53 / OCI DNS failover |
| Advanced suppression | Category-based (marketing vs transactional) |
| Public API docs | OpenAPI 3.1, developer portal |
| SLA monitoring | Per-tenant SLA reports |

---

## 11. LiteDesk Integration Checklist

Use this when wiring LiteDesk (OCI Compute #1) to AMDS (OCI Compute #2):

### Infrastructure
- [ ] Both computes in same VCN (or peered VCNs)
- [ ] Security list: LiteDesk → AMDS on port 443
- [ ] Security list: AMDS → LiteDesk webhook on port 443
- [ ] AMDS egress IP has PTR record configured
- [ ] OCI Vault secrets shared via instance principal or API key

### LiteDesk Application
- [ ] Add `AMDS_BASE_URL`, `AMDS_API_KEY`, `AMDS_WEBHOOK_SECRET` to env
- [ ] Implement `AmdsEmailService` wrapper
- [ ] Implement `POST /api/internal/webhooks/amds` with signature verification
- [ ] Map Helpdesk reply → `POST /v1/messages`
- [ ] Store `message_id` on ticket for status correlation
- [ ] Handle bounce events → mark contact email invalid

### AMDS Application
- [ ] Register LiteDesk tenant + API key
- [ ] Configure webhook URL → `https://<litedesk-host>/api/internal/webhooks/amds`
- [ ] Test idempotency with duplicate ticket reply saves
- [ ] Load test: 100 concurrent transactional sends

---

## 12. API Surface Summary (v1)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Send single or templated message |
| GET | `/v1/messages/{id}` | Message status + events |
| POST | `/v1/domains` | Register sending domain |
| GET | `/v1/domains/{domain}` | Domain status + DNS records |
| POST | `/v1/domains/{domain}/verify` | Trigger DNS verification |
| GET | `/v1/suppressions` | List suppressed addresses |
| POST | `/v1/suppressions` | Manual suppress |
| DELETE | `/v1/suppressions/{email}` | Remove suppression |
| GET | `/v1/analytics/summary` | Aggregated stats |
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness (DB + queue) |

---

## 13. Security Checklist

- [ ] TLS everywhere (API + webhooks + SMTP STARTTLS)
- [ ] API keys rotated quarterly; scoped per tenant
- [ ] Webhook HMAC verification on LiteDesk side
- [ ] DKIM private keys in OCI Vault only
- [ ] Tenant data isolation (row-level security in PostgreSQL)
- [ ] Rate limits: per tenant, per recipient domain
- [ ] Input sanitization on HTML content (XSS in email)
- [ ] Attachment scanning (ClamAV) before send
- [ ] Audit log for domain changes and suppression edits
- [ ] No secrets in git; `.env` in `.gitignore` (already configured)

---

## 14. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| IP reputation damage | Emails go to spam | Dedicated IP, warm-up, bounce handling |
| LiteDesk unreachable for webhooks | Stale delivery status | AMDS retry queue; LiteDesk polls `GET /v1/messages/{id}` |
| Queue backlog during campaign | Delayed transactional mail | Separate queues; transaction priority |
| DNS misconfiguration | DKIM/SPF fail | Domain verify API + health monitoring |
| OCI SMTP port 25 blocked | Cannot deliver | Request port 25 unblock; use 587 submission relay |
| Single compute failure | Full outage | LB + multi-instance (Phase 4) |

---

## 15. Success Metrics

| Metric | Phase 1 Target | Production Target |
|--------|----------------|-------------------|
| Transactional delivery latency (p95) | < 60s | < 30s |
| Delivery rate | > 95% | > 98% |
| Hard bounce handling | Manual | Automatic < 1 min |
| Gateway uptime | 99% | 99.9% |
| Webhook delivery success | > 95% | > 99% |
| Complaint rate | N/A | < 0.1% |

---

## 16. Next Steps (Implementation Kickoff)

Decisions confirmed:

| Decision | Choice |
|----------|--------|
| Network | **Same OCI VCN**, separate subnets, private API traffic |
| LiteDesk stack | **Node.js + Vue 3 + MongoDB** |
| AMDS stack | **Node.js (Fastify) + PostgreSQL + Redis** |
| Phase 1 scope | Helpdesk transactional replies (recommended starting point) |

Ready to start (**local first**):

1. **Phase 0a** — VMDS repo scaffold + `docker compose up` + gateway/worker → Mailpit
2. **Phase 0a (LiteDesk)** — `AmdsClient` + webhook route on `localhost:3000`
3. **Validate locally** — full Helpdesk reply flow in Mailpit UI
4. **Phase 0b** — OCI deploy when local checklist passes (env URL swap only)

---

## Appendix A — Environment Variables

### Local development (your Mac)

```bash
# AMDS — .env in VMDS repo
AMDS_PORT=8080
DATABASE_URL=postgresql://amds:amds@localhost:5432/amds
REDIS_URL=redis://localhost:6379
SMTP_HOST=localhost
SMTP_PORT=1025          # Mailpit — no port 25 needed locally
SMTP_SECURE=false
WEBHOOK_SIGNING_SECRET=dev_webhook_secret
LITEDESK_WEBHOOK_URL=http://host.docker.internal:3000/api/internal/webhooks/amds
# On Mac, workers use host.docker.internal to reach LiteDesk on host

# LiteDesk — .env in LiteDesk repo
AMDS_BASE_URL=http://localhost:8080
AMDS_API_KEY=amds_dev_key
AMDS_WEBHOOK_SECRET=dev_webhook_secret
MONGODB_URI=mongodb://localhost:27017/litedesk
```

### AMDS (Compute #2 — OCI)

```bash
AMDS_PORT=8080
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
SMTP_EGRESS_IP=xxx.xxx.xxx.xxx
OCI_VAULT_OCID=ocid1.vault...
WEBHOOK_SIGNING_SECRET=...
DEFAULT_FROM_DOMAIN=mail.amds.example.com
```

### LiteDesk (Compute #1 — Node.js + MongoDB)

```bash
# Private VCN communication (same VCN, private subnet 10.0.2.0/24)
AMDS_BASE_URL=https://amds.internal:8080
AMDS_API_KEY=amds_live_...
AMDS_WEBHOOK_SECRET=whsec_...
AMDS_WEBHOOK_PATH=/api/internal/webhooks/amds

# MongoDB — store correlation on tickets/campaigns
# amds_message_id, delivery_status, last_amds_event_at
MONGODB_URI=mongodb://...
```

---

## Appendix B — Glossary

| Term | Definition |
|------|------------|
| **AMDS** | Arivu Mail Delivery System |
| **VMDS** | Repository/product name for AMDS codebase |
| **LiteDesk** | Business platform (CRM, Helpdesk, etc.) |
| **FBL** | Feedback Loop (ISP spam complaint forwarding) |
| **VERP** | Variable Envelope Return Path (bounce routing) |
| **DSN** | Delivery Status Notification |

---

*Document maintained in `/docs/AMDS-END-TO-END-ROADMAP.md`. Update version and date on each major revision.*
