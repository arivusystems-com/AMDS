# Build Locally → Deploy Once (Option A)

**Strategy:** Build and validate the full AMDS platform on localhost (Mailpit). Deploy to OCI **once** when all local exit gates pass. No third-party SMTP providers. No bouncing between local and cloud mid-build.

**Full OCI deploy (networking, multi-IP, DNS, systemd, smoke tests):** [OCI-DEPLOY-END-TO-END.md](./OCI-DEPLOY-END-TO-END.md)

**Related:** [AMDS-END-TO-END-ROADMAP.md](./AMDS-END-TO-END-ROADMAP.md) · [PHASE-0A-COMPLETE.md](./PHASE-0A-COMPLETE.md) · [TRACK-2-COMPLETE.md](./TRACK-2-COMPLETE.md) · [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

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
npm run validate:track-2
```

For webhook retry coverage in `validate:track-2`, start the worker with  
`LITEDESK_WEBHOOK_URL=http://localhost:3999/api/internal/webhooks/amds` (validation script starts a mock server on port 3999).

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

### Track 2 — Production delivery engine ✅ Complete

Build the real delivery path; test against Mailpit. See [TRACK-2-COMPLETE.md](./TRACK-2-COMPLETE.md).

| Task | Deliverable | Status |
|------|-------------|--------|
| Direct SMTP transport module | MX lookup + connect (used on OCI; mockable in tests) | [x] |
| Retry queue | Soft failures → BullMQ retry with backoff | [x] |
| Dead letter handling | Failed after max attempts → DLQ table + status | [x] |
| Webhook delivery retries | Exponential backoff to LiteDesk (72h window) | [x] |
| Per-tenant rate limiting | Token bucket in Redis | [x] |
| Message events table | Append-only delivery attempts + events on `GET /v1/messages/:id` | [x] |
| Structured logging | JSON logs with `message_id`, `tenant_id` | [x] |
| Validation script | `npm run validate:track-2` | [x] |

**Local exit gate:** Retry and webhook-retry behavior proven in Mailpit; `validate:track-2` passes in CI. **Complete.**

---

### Track 3 — Domain auth, bounces, scheduling ✅ Complete

See [TRACK-3-COMPLETE.md](./TRACK-3-COMPLETE.md).

| Task | Deliverable | Status |
|------|-------------|--------|
| `POST /v1/domains` | Register sending domain per tenant | [x] |
| DNS record generation | SPF, DKIM, DMARC records returned to caller | [x] |
| `POST /v1/domains/:domain/verify` | DNS lookup validation | [x] |
| DKIM signing in worker | Sign outbound mail when domain verified | [x] |
| Suppression list API | `GET/POST/DELETE /v1/suppressions` | [x] |
| Scheduled queue | Honor `scheduled_at` on messages | [x] |
| Bounce parser | DSN classification (hard/soft) — unit tests + fixtures | [x] |
| Bounce simulation script | Inject `message.bounced` without inbound SMTP | [x] |
| Webhooks v2 | `message.bounced`, `message.complained` | [x] partial — bounced only |
| LiteDesk bounce handling | Suppress contact, notify agent | [ ] LiteDesk repo |
| Validation script | `npm run validate:track-3` | [x] |

**Local exit gate:** `validate:track-3` passes in CI. **Complete** (AMDS side).

---

### Track 4 — Campaigns, tracking, analytics (local)

| Task | Deliverable | Status |
|------|-------------|--------|
| Campaign queue | Separate queue for bulk sends | [x] |
| Batch ingest API | `POST /v1/campaigns/:id/messages` | [x] |
| Open tracking | `GET /t/:token.png` pixel endpoint | [x] |
| Click tracking | `GET /c/:token` → 302 redirect | [x] |
| Webhooks | `message.opened`, `message.clicked` | [x] |
| Analytics API | `GET /v1/analytics/summary` | [x] |
| Worker concurrency tuning | Campaign vs transaction priority | [x] |
| LiteDesk Marketing integration | Campaign send + stats UI | [ ] |
| Validation script | `npm run validate:track-4` | [x] |

**Local exit gate:** Batch send to Mailpit; open/click events fire webhooks to LiteDesk; analytics returns counts.

---

### Track 5 — Production hardening (local + OCI)

Build locally where possible; prove on OCI at deploy.

| Task | Where | Status |
|------|-------|--------|
| Multi-worker processes | Local | [x] |
| Graceful shutdown | Local | [x] |
| Prometheus metrics endpoint | Local | [x] |
| Runbooks (incident, bounce spike) | Docs | [x] |
| Terraform / deploy scripts | Repo | [x] |
| OCI VCN + compute + security lists | OCI | [ ] (prep during build) |
| Port 25 unblock request | OCI support | [ ] (open early) |
| PTR / reverse DNS | OCI | [ ] (at deploy) |
| IP warm-up program | OCI | [ ] (post-deploy) |
| Load balancer + gateway HA | OCI | [ ] (post-MVP) |

See [TRACK-5-COMPLETE.md](./TRACK-5-COMPLETE.md) · [runbooks/](./runbooks/) · [deploy/](../deploy/)

---

## Pre-deploy validation (all tracks)

Run before any OCI application deploy:

```bash
npm run docker:up
npm run db:migrate
npm run dev          # separate terminal
npm run validate:phase-0a
npm run validate:track-2
npm run validate:track-3   # DNS_VERIFY_BYPASS=true ENFORCE_DOMAIN_VERIFICATION=true on gateway
npm run validate:track-4   # LITEDESK_WEBHOOK_URL=http://127.0.0.1:3997/... on gateway
npm run validate:track-5
npm run validate:track-6
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

1. ~~**Track 2** — retry queue, webhook retries, rate limits, message events~~ ✅
1. ~~**Track 3** — domains, DKIM, suppressions, scheduled send, bounce simulation~~ ✅
2. ~~**Track 3** — domains, DKIM, suppressions, scheduled send, bounce simulation~~ ✅
3. ~~**Track 4** — campaigns, tracking, analytics~~ ✅ (AMDS side)
4. ~~**Track 5 prep** — metrics, multi-worker, runbooks, Terraform~~ ✅ (local)
5. **OCI deploy** — single cutover + real inbox smoke test

---

*Update task checkboxes in this file as tracks complete. Bump “Last updated” when making substantive changes.*

**Last updated:** June 30, 2026
