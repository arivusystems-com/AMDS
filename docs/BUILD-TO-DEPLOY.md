# Build Locally → Deploy Once (Option A)

**Strategy:** Build and validate the full AMDS platform on localhost (Mailpit). Deploy to OCI **once** when all local exit gates pass. No third-party SMTP providers. No bouncing between local and cloud mid-build.

**Related:** [AMDS-END-TO-END-ROADMAP.md](./AMDS-END-TO-END-ROADMAP.md) · [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md) · [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

---

## Principles

1. **Self-hosted only** — AMDS delivers mail directly (MX + SMTP on OCI). No SendGrid/Mailgun/SES in the path.
2. **Mailpit for all local delivery** — fast iteration, CI, LiteDesk E2E. Real inbox proof happens **once on OCI** at the end.
3. **Env-driven deploy** — cloud cutover is URL/secret swap + DNS, not application rewrites.
4. **Open OCI port-25 ticket early** — can run in parallel during local build (takes days; no deploy required).

---

## SMTP modes

| Mode | Environment | SMTP target | When |
|------|-------------|-------------|------|
| `mailpit` | Local (default) | `localhost:1025` | All development and validation |
| `direct` | OCI production | MX lookup + port 25 | After local exit gates pass |

There is **no relay profile**. Local never sends to real inboxes; OCI does that on first smoke test.

---

## Daily workflow

```bash
# Terminal 1 — infrastructure
npm run docker:up && npm run db:migrate

# Terminal 2 — AMDS
npm run dev

# Terminal 3 — LiteDesk (separate repo)
cd ../LiteDesk && npm run dev

# Automated check (gateway + worker must be running)
npm run validate:phase-0a
```

**Mailpit UI:** http://localhost:8025

---

## Build tracks

### Track 1 — Core pipeline ✅ Complete

Phase 0a exit criteria met. See [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md).

- [x] Monorepo (gateway, worker, shared)
- [x] Docker: Postgres, Redis, Mailpit
- [x] `GET /health`, `GET /ready`
- [x] `POST /v1/messages`, `GET /v1/messages/:id`
- [x] API key auth, idempotency
- [x] Transaction queue + worker → Mailpit
- [x] Webhooks `message.delivered` / `message.failed`
- [x] LiteDesk integration (CRM, Cases, webhooks)
- [x] CI + `npm run validate:phase-0a`

---

### Track 2 — Production delivery engine (local)

Build the real delivery path; test against Mailpit (same nodemailer transport, production code paths elsewhere).

| Task | Deliverable | Status |
|------|-------------|--------|
| Direct SMTP transport module | MX lookup + connect (used on OCI; mockable in tests) | [ ] |
| Retry queue | Soft failures → BullMQ retry with backoff | [ ] |
| Dead letter handling | Failed after max attempts → DLQ table + status | [ ] |
| Webhook delivery retries | Exponential backoff to LiteDesk (72h window) | [ ] |
| Per-tenant rate limiting | Token bucket in Redis | [ ] |
| Message events table | Append-only delivery attempts + events on `GET /v1/messages/:id` | [ ] |
| Structured logging | JSON logs with `message_id`, `tenant_id` | [ ] |
| Validation script | `npm run validate:track-2` | [ ] |

**Local exit gate:** Retry and webhook-retry behavior proven in Mailpit; `validate:track-2` passes in CI.

---

### Track 3 — Domain auth, bounces, scheduling (local)

| Task | Deliverable | Status |
|------|-------------|--------|
| `POST /v1/domains` | Register sending domain per tenant | [ ] |
| DNS record generation | SPF, DKIM, DMARC records returned to caller | [ ] |
| `POST /v1/domains/:domain/verify` | DNS lookup validation | [ ] |
| DKIM signing in worker | Sign outbound mail when domain verified | [ ] |
| Suppression list API | `GET/POST/DELETE /v1/suppressions` | [ ] |
| Scheduled queue | Honor `scheduled_at` on messages | [ ] |
| Bounce parser | DSN classification (hard/soft) — unit tests + fixtures | [ ] |
| Bounce simulation script | Inject `message.bounced` without inbound SMTP | [ ] |
| Webhooks v2 | `message.bounced`, `message.complained` | [ ] |
| LiteDesk bounce handling | Suppress contact, notify agent | [ ] |
| Validation script | `npm run validate:track-3` | [ ] |

**Local exit gate:** Domain verify flow works against real DNS (if you control a test domain); bounce simulation updates LiteDesk; DKIM signs correctly (verify via parsed Mailpit MIME headers).

**Note:** Live inbound bounce SMTP (port 25 ingress) is validated on OCI. Parser and webhook path are fully testable locally.

---

### Track 4 — Campaigns, tracking, analytics (local)

| Task | Deliverable | Status |
|------|-------------|--------|
| Campaign queue | Separate queue for bulk sends | [ ] |
| Batch ingest API | `POST /v1/campaigns/:id/messages` | [ ] |
| Open tracking | `GET /t/:token.png` pixel endpoint | [ ] |
| Click tracking | `GET /c/:token` → 302 redirect | [ ] |
| Webhooks | `message.opened`, `message.clicked` | [ ] |
| Analytics API | `GET /v1/analytics/summary` | [ ] |
| Worker concurrency tuning | Campaign vs transaction priority | [ ] |
| LiteDesk Marketing integration | Campaign send + stats UI | [ ] |
| Validation script | `npm run validate:track-4` | [ ] |

**Local exit gate:** Batch send to Mailpit; open/click events fire webhooks to LiteDesk; analytics returns counts.

---

### Track 5 — Production hardening (local + OCI)

Build locally where possible; prove on OCI at deploy.

| Task | Where | Status |
|------|-------|--------|
| Multi-worker processes | Local | [ ] |
| Graceful shutdown | Local | [ ] |
| Prometheus metrics endpoint | Local | [ ] |
| Runbooks (incident, bounce spike) | Docs | [ ] |
| Terraform / deploy scripts | Repo | [ ] |
| OCI VCN + compute + security lists | OCI | [ ] (prep during build) |
| Port 25 unblock request | OCI support | [ ] (open early) |
| PTR / reverse DNS | OCI | [ ] (at deploy) |
| IP warm-up program | OCI | [ ] (post-deploy) |
| Load balancer + gateway HA | OCI | [ ] (post-MVP) |

---

## Pre-deploy validation (all tracks)

Run before any OCI application deploy:

```bash
npm run docker:up
npm run db:migrate
npm run dev          # separate terminal
npm run validate:phase-0a
# npm run validate:track-2   # when added
# npm run validate:track-3   # when added
# npm run validate:track-4   # when added
```

**LiteDesk manual E2E (local):**

1. Settings → Integrations → Email → **AMDS**
2. Send from Cases / CRM → Mailpit shows message
3. Communication status → `delivered`
4. (Track 3+) Trigger bounce simulation → status updates
5. (Track 4+) Campaign batch → all recipients in Mailpit

---

## OCI deploy (once, at the end)

Only after all track exit gates pass.

### Parallel prep (start during local build)

- [ ] Open OCI **port 25 unblock** support ticket
- [ ] Draft Terraform/Ansible for VCN, subnets, compute, security lists
- [ ] Plan internal DNS: `amds.internal`, `litedesk.internal`
- [ ] List production DNS records (SPF, DKIM, DMARC, `track.*`, `bounce.*`)

### Deploy day

1. Provision OCI compute (AMDS VM in private subnet, same VCN as LiteDesk)
2. Deploy Postgres + Redis (co-located or managed)
3. Deploy gateway + worker (same artifacts as local)
4. Swap env:

   ```bash
   SMTP_MODE=direct
   SMTP_HOST=          # unused — worker uses MX lookup
   DATABASE_URL=postgresql://...
   REDIS_URL=redis://...
   LITEDESK_WEBHOOK_URL=https://litedesk.internal/api/internal/webhooks/amds
   ```

5. Configure security lists: LiteDesk → AMDS `:8080`; AMDS → LiteDesk webhook; block public `/v1/*`
6. Apply DNS (SPF, DKIM, DMARC, tracking, bounce)
7. Request PTR for egress IP

### Post-deploy smoke tests

- [ ] `GET /health` from LiteDesk private IP
- [ ] Helpdesk reply → **real Gmail/Outlook inbox**
- [ ] Webhook `message.delivered` in LiteDesk
- [ ] mail-tester.com score acceptable (Track 3 DKIM/SPF)
- [ ] One intentional hard bounce → suppression + webhook (live inbound SMTP)

**Exit criteria:** Same flow as local, but mail arrives in a real inbox and DNS auth passes.

---

## What stays local-only vs OCI-only

| Capability | Local (Mailpit) | OCI |
|------------|-----------------|-----|
| API, queues, webhooks | ✅ | ✅ |
| LiteDesk E2E | ✅ | ✅ |
| Retry / DLQ / rate limits | ✅ | ✅ |
| Domain verify + DKIM sign | ✅ (DNS + Mailpit headers) | ✅ |
| Bounce parser unit tests | ✅ | ✅ |
| Live ISP bounces (inbound 25) | Simulate | ✅ |
| Real inbox delivery | ❌ | ✅ |
| PTR / IP reputation | ❌ | ✅ |
| Public tracking URLs | localhost | `track.yourdomain.com` |

---

## Implementation order (recommended)

1. **Track 2** — retry queue, webhook retries, rate limits, message events
2. **Track 3** — domains, DKIM, suppressions, scheduled send, bounce simulation
3. **Track 4** — campaigns, tracking, analytics
4. **Track 5 prep** — Terraform, port-25 ticket, runbooks
5. **OCI deploy** — single cutover + real inbox smoke test

---

*Update task checkboxes in this file as tracks complete. Bump “Last updated” when making substantive changes.*

**Last updated:** June 30, 2026
