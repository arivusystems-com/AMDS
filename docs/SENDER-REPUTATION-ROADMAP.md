# AMDS Sender Reputation & Dynamic Rate Limiting — Implementation Roadmap

**Source:** *AMDS Sender Reputation & Dynamic Rate Limiting Architecture* v2.1 (July 2026)  
**Status:** AMDS Track 6 Phases 1–6 complete (local) — see [TRACK-6-COMPLETE.md](./TRACK-6-COMPLETE.md)  
**Related:** [AMDS-END-TO-END-ROADMAP.md](./AMDS-END-TO-END-ROADMAP.md) · [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) · [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

---

## 1. Executive summary

The attached architecture introduces a **two-layer control model**:

| Layer | Owner | Controls |
|-------|-------|----------|
| **Entitlements** | LiteDesk | Credits, daily/hourly/burst limits, tenant status, billing |
| **Enforcement** | AMDS | Credit consumption, sender reputation (0–100), dynamic throughput, warm-up, infrastructure protection |

**Key design principle:** Credits and reputation are **independent**. A tenant with 80,000 remaining credits and reputation 62 still owns those credits — AMDS only reduces **delivery speed**, not entitlement.

This roadmap maps the PDF spec to AMDS/LiteDesk work, sequenced after current Track 5 completion and aligned with OCI deploy.

---

## 2. Gap analysis — current state vs spec

### 2.1 AMDS today

| Capability | Current | Spec requires |
|------------|---------|---------------|
| Rate limiting | Global per-tenant token bucket (`RATE_LIMIT_MAX` / window) | Per-tenant policies synced from LiteDesk: daily, hourly, burst |
| Sender reputation | None | Continuous 0–100 score, event-driven |
| Dynamic throughput | None | `max_hourly × reputation × warm-up × infra` |
| Warm-up engine | Manual runbook only | Automated tenant progression (Day 1 → established) |
| Credit consumption | None | Reserve → queue → consume lifecycle |
| Campaign health | Analytics counts only | Per-campaign health score (0–100) |
| Reputation signals | Partial raw events | Rolling windows (7d/14d/30d) + weighted formula |
| Progressive enforcement | None | Throttle → restrict marketing → suspend by score band |
| Reputation guidance | None | Change reasons + recommendations API |
| Infrastructure multiplier | None | Queue depth / SMTP pressure / shared IP throttling |
| LiteDesk sync (inbound) | Webhooks for delivery events only | Config sync API + reputation/credit/throughput events |
| Complaints | Type defined, not implemented | Required for 30% of reputation weight |
| Inbound bounces (live) | Simulation only | Required for hard-bounce signal (30% weight) |

### 2.2 LiteDesk today

| Capability | Current | Spec requires |
|------------|---------|---------------|
| Tenant email config | Not modeled for AMDS sync | Monthly credits, daily limit, hourly rate, burst, max campaign size, warm-up/reputation flags |
| Credit allocation / billing | Not integrated with AMDS | Source of truth; sync to AMDS |
| Campaign pre-send UI | Track 4 draft only | Credits required, reputation, effective rate, ETA |
| Reputation display | None | Score, delta, reasons, recommendations |
| Config sync to AMDS | None | Push on tenant create/update/suspend/credit purchase |
| AMDS event consumption | Delivery/bounce webhooks | + reputation changes, credit consumption, throughput updates |

### 2.3 Architectural fit

The PDF aligns with existing separation of concerns:

- **LiteDesk** already owns business logic; extend with email entitlements.
- **AMDS** already owns queues, analytics, suppressions, domain auth — add reputation engine and policy-aware rate limiter on top.

No conflict with current Tracks 1–5. This is **Track 6** (platform governance) plus **LiteDesk Track 4.5/5** (billing + campaign UX).

---

## 3. Target architecture

```
LiteDesk                          AMDS
────────                          ────
Tenant / Billing                  Gateway (policy check on ingest)
Email Credits ──sync──►           Tenant Policies (read-only cache)
Sending Limits                    Credit Ledger (reserve/consume)
Burst / Hourly config             Reputation Engine
                                  ├─ Rolling Metrics Store (Redis + PG)
                                  ├─ Score Calculator (event-driven)
                                  └─ Multiplier Resolver
                                  Rate Limiter (hourly/burst/daily)
                                  Warm-up Engine
                                  Infrastructure Guard
                                  Queue (transaction / campaign)
                                  Delivery Engine
◄──webhooks/events──              Analytics + Campaign Health
Reputation UI                     Admin override (platform only)
Campaign ETA UI
```

### 3.1 Throughput formula (from spec)

```
Effective Rate = Max Hourly Rate
               × Reputation Multiplier
               × Warm-up Multiplier
               × Infrastructure Multiplier
```

### 3.2 Reputation multiplier bands (from spec)

| Score | Multiplier |
|-------|------------|
| 95–100 | 100% |
| 90–94 | 90% |
| 80–89 | 75% |
| 70–79 | 50% |
| 60–69 | 30% |
| 50–59 | 15% |
| < 50 | Restricted |

### 3.3 Warm-up progression (from spec)

| Stage | Throughput cap |
|-------|----------------|
| Day 1 | 5% |
| Week 1 | 20% |
| Week 2 | 40% |
| Week 3 | 70% |
| Established | 100% (auto-disable warm-up when reputation sufficient) |

### 3.4 Progressive enforcement (from spec)

| Reputation | Behaviour |
|------------|-----------|
| 90–100 | Full throughput |
| 80–89 | Minor throttling |
| 70–79 | Moderate throttling |
| 60–69 | Heavy throttling |
| 50–59 | Manual monitoring flag |
| 40–49 | Marketing campaigns restricted |
| < 20 | Sending suspended (admin review) |

Transactional queue may remain more permissive than campaign queue at each band.

---

## 4. Phased implementation roadmap

### Phase 0 — Prerequisites (1–2 weeks)

**Goal:** Unblock reputation signals that the engine depends on.

| # | Work | Owner | Deliverable |
|---|------|-------|-------------|
| 0.1 | OCI deploy + real delivery | Ops + AMDS | Live SMTP, PTR, DNS auth |
| 0.2 | Inbound bounce SMTP | AMDS | Live DSN → hard/soft classification |
| 0.3 | Complaint / FBL processing | AMDS | `message.complained` webhook + suppression |
| 0.4 | LiteDesk Track 4 | LiteDesk | Campaign send + open/click webhooks |

**Exit criteria:** Hard bounces and complaints flow as real events; campaign analytics populated.

---

### Phase 1 — Tenant policies & credit ledger (2–3 weeks)

**Goal:** LiteDesk syncs entitlements; AMDS enforces credits and static limits.

#### AMDS

| # | Task | Details |
|---|------|---------|
| 1.1 | Migration `005_tenant_policies.sql` | `tenant_policies`, `credit_ledger`, `credit_reservations` |
| 1.2 | `PUT /v1/tenants/:id/policy` | LiteDesk pushes config (read-only in AMDS) |
| 1.3 | `GET /v1/tenants/:id/policy` | Read-back for debugging |
| 1.4 | Credit lifecycle | Reserve on accept → consume on delivery → release on failure |
| 1.5 | Static limit enforcement | Daily limit, hourly rate, burst rate, max campaign size |
| 1.6 | Replace global rate limiter | Policy-aware limiter using synced values |
| 1.7 | Tenant status gate | `active` / `suspended` — reject sends when suspended |
| 1.8 | Webhooks | `credit.consumed`, `credit.reserved`, `policy.limit_exceeded` |
| 1.9 | Validation | `npm run validate:track-6a` |

#### LiteDesk

| # | Task | Details |
|---|------|---------|
| 1.10 | Tenant email config model | MongoDB schema for credits, limits, flags |
| 1.11 | Policy sync service | Push to AMDS on create/update/suspend/credit purchase |
| 1.12 | Billing hooks | Allocate credits on subscription / pack purchase |
| 1.13 | Settings UI | Admin view of synced limits |

**Exit criteria:** Campaign rejected when credits exhausted; daily/hourly/burst limits return `429` with structured error; credits decrement on delivery only.

---

### Phase 2 — Rolling metrics & reputation engine (3–4 weeks)

**Goal:** Continuous sender reputation (0–100) updated on every delivery event.

#### AMDS

| # | Task | Details |
|---|------|---------|
| 2.1 | Migration `006_reputation.sql` | `tenant_reputation`, `reputation_events`, `rolling_metrics` |
| 2.2 | Metrics collector | Subscribe to delivery, bounce, open, click, complaint events |
| 2.3 | Rolling windows | 7d complaints, 30d bounces/delivery/engagement, 14d consistency, current auth/blacklist |
| 2.4 | Score calculator | Weighted formula per spec (hard bounce 30%, complaints 30%, delivery 15%, open 10%, click 5%, auth 5%, consistency 5%) |
| 2.5 | Event-driven updates | Recalculate on each signal; no batch-only scoring |
| 2.6 | Initial score | New tenants start at configurable default (e.g. 70) |
| 2.7 | Admin override | Platform admin set score (audit logged) — spec exception |
| 2.8 | `GET /v1/tenants/:id/reputation` | Current score + breakdown |
| 2.9 | `GET /v1/tenants/:id/reputation/history` | Time series for charts |
| 2.10 | Webhooks | `reputation.updated` with delta + contributing factors |
| 2.11 | Validation | `npm run validate:track-6b` |

#### LiteDesk

| # | Task | Details |
|---|------|---------|
| 2.12 | Reputation webhook handler | Update tenant cache |
| 2.13 | Settings → Email reputation card | Score, weekly delta |

**Exit criteria:** Simulated bounce/complaint lowers score within seconds; delivery + engagement raises score gradually; score never manually editable by tenant.

---

### Phase 3 — Dynamic throughput & warm-up (2–3 weeks)

**Goal:** Effective sending rate computed from multipliers; warm-up for new senders.

#### AMDS

| # | Task | Details |
|---|------|---------|
| 3.1 | Multiplier resolver | Reputation + warm-up + infra multipliers |
| 3.2 | Warm-up engine | Track tenant `first_send_at`; apply Day 1 → Week 3 progression |
| 3.3 | Warm-up auto-disable | Disable when reputation ≥ threshold (e.g. 85) for N days |
| 3.4 | Queue pacing | Token bucket at **effective hourly rate**, not static max |
| 3.5 | Campaign ETA API | `GET /v1/campaigns/:id/estimate` — recipients ÷ effective rate |
| 3.6 | Progressive enforcement | Score bands → marketing restrict / full suspend |
| 3.7 | Transactional bypass | Helpdesk queue uses higher floor multiplier |
| 3.8 | `GET /v1/tenants/:id/throughput` | Max vs effective rate + active multipliers |
| 3.9 | Webhooks | `throughput.updated` when effective rate changes |
| 3.10 | Validation | `npm run validate:track-6c` |

#### LiteDesk

| # | Task | Details |
|---|------|---------|
| 3.11 | Campaign composer UI | Show effective rate + estimated completion time |
| 3.12 | Pre-send validation | Block marketing send if reputation < 40 |

**Exit criteria:** Tenant at reputation 82 with max 5,000/hr gets ~3,750/hr effective rate; new tenant capped at 5% day 1; ETA shown before send.

---

### Phase 4 — Campaign health & customer guidance (2 weeks)

**Goal:** Per-campaign quality score separate from tenant reputation; actionable feedback.

#### AMDS

| # | Task | Details |
|---|------|---------|
| 4.1 | Campaign health calculator | Per-campaign delivery, opens, clicks, bounce, complaint rates |
| 4.2 | `GET /v1/campaigns/:id/health` | Score 0–100 + metrics |
| 4.3 | Reputation guidance engine | Diff previous vs current; emit reasons (✓/✗) |
| 4.4 | Recommendations | Rule-based tips (list hygiene, auth, spike avoidance) |
| 4.5 | `GET /v1/tenants/:id/reputation/guidance` | Score, delta, reasons, recommendations |
| 4.6 | Extend analytics summary | Include reputation + campaign health columns |

#### LiteDesk

| # | Task | Details |
|---|------|---------|
| 4.7 | Campaign detail health badge | Campaign health vs sender reputation side-by-side |
| 4.8 | Reputation guidance panel | Reasons + recommendations in Settings → Email |

**Exit criteria:** Campaign health 92 and sender reputation 84 shown independently; user sees why score changed.

---

### Phase 5 — Infrastructure protection & recovery (2 weeks)

**Goal:** Platform-level throttling; gradual reputation recovery; IP warm-up alignment.

#### AMDS

| # | Task | Details |
|---|------|---------|
| 5.1 | Infrastructure multiplier | Reduce throughput when queue depth, SMTP errors, or shared IP pressure high |
| 5.2 | IP-level warm-up | Extend runbook schedule to automated egress IP caps (ties to BOUNCE-SPIKE runbook) |
| 5.3 | Recovery curve | Cap reputation gain per day to prevent gaming |
| 5.4 | Blacklist / spam-trap signals | Negative signals (manual feed or future integration) |
| 5.5 | Prometheus metrics | `amds_reputation_score`, `amds_effective_rate`, multiplier gauges |
| 5.6 | Runbook update | INCIDENT.md + BOUNCE-SPIKE.md for reputation suspension |

**Exit criteria:** High queue load reduces all tenants' infra multiplier; reputation recovers gradually over weeks, not instantly.

---

### Phase 6 — Hardening & enterprise (ongoing)

| # | Task | Notes |
|---|------|-------|
| 6.1 | Dedicated IP pools | Transaction vs marketing — separate infra multiplier per pool |
| 6.2 | OCI Vault for policy secrets | If any shared signing keys |
| 6.3 | Read replicas | Reputation history queries off primary |
| 6.4 | OpenAPI docs | Public tenant/reputation/credit APIs |
| 6.5 | Penetration test | Policy sync auth, credit manipulation |
| 6.6 | Load test | 10K+ recipient campaign under dynamic throttling |

---

## 5. Data model (proposed)

### 5.1 `tenant_policies` (AMDS — synced from LiteDesk)

```sql
tenant_id              TEXT PRIMARY KEY
status                 TEXT          -- active | suspended
monthly_credits        BIGINT
credits_remaining      BIGINT        -- synced; AMDS decrements
daily_send_limit       INT
max_hourly_rate        INT
burst_rate_per_min     INT
max_campaign_size      INT
warmup_enabled         BOOLEAN
reputation_enabled     BOOLEAN
first_send_at          TIMESTAMPTZ   -- AMDS-set on first delivery
synced_at              TIMESTAMPTZ
```

### 5.2 `credit_ledger` (AMDS — source of truth for consumption)

```sql
id, tenant_id, message_id, campaign_id
action                 TEXT          -- reserve | consume | release
amount                 INT
balance_after          BIGINT
created_at             TIMESTAMPTZ
```

### 5.3 `tenant_reputation` (AMDS — source of truth)

```sql
tenant_id              TEXT PRIMARY KEY
score                  NUMERIC(5,2)  -- 0.00–100.00
previous_score         NUMERIC(5,2)
reputation_multiplier  NUMERIC(4,3)
warmup_multiplier      NUMERIC(4,3)
infra_multiplier       NUMERIC(4,3)
effective_hourly_rate  INT
updated_at             TIMESTAMPTZ
```

### 5.4 `rolling_metrics` (AMDS)

```sql
tenant_id, metric_key, window_days, value, sample_count, updated_at
-- e.g. hard_bounce_rate_30d, complaint_rate_7d, delivery_rate_30d
```

---

## 6. API contract (new endpoints)

### LiteDesk → AMDS (config sync)

| Method | Path | Purpose |
|--------|------|---------|
| `PUT` | `/v1/tenants/:tenant_id/policy` | Upsert entitlements + limits |
| `PATCH` | `/v1/tenants/:tenant_id/credits` | Add credits (purchase/allocate) |
| `POST` | `/v1/tenants/:tenant_id/suspend` | Suspend sending |
| `POST` | `/v1/tenants/:tenant_id/activate` | Re-enable |

### AMDS → LiteDesk (webhooks)

| Event | When |
|-------|------|
| `credit.reserved` | Campaign/messages accepted |
| `credit.consumed` | Message delivered |
| `credit.released` | Reservation cancelled (failure before send) |
| `reputation.updated` | Score change with factors |
| `throughput.updated` | Effective rate change |
| `policy.limit_exceeded` | Daily/hourly/burst/campaign size hit |
| `tenant.suspended` | Score < 20 or admin action |

### AMDS read APIs (LiteDesk UI + admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/tenants/:id/reputation` | Score + breakdown |
| `GET` | `/v1/tenants/:id/reputation/guidance` | Reasons + recommendations |
| `GET` | `/v1/tenants/:id/throughput` | Max vs effective rate |
| `GET` | `/v1/campaigns/:id/health` | Campaign health score |
| `GET` | `/v1/campaigns/:id/estimate` | Completion ETA |

---

## 7. Send-path integration (where enforcement runs)

```
POST /v1/messages or /v1/campaigns/:id/messages
  │
  ├─ 1. Tenant active?                    → 403 if suspended
  ├─ 2. Credits available?                → 402/422 if insufficient
  ├─ 3. Campaign size ≤ max?              → 422
  ├─ 4. Daily limit headroom?             → 429
  ├─ 5. Reputation band allows queue?     → 403 marketing if < 40
  ├─ 6. Reserve credits                   → ledger entry
  ├─ 7. Enqueue with effective rate hint  → pacing metadata
  │
Worker dequeue
  │
  ├─ 8. Throughput token (hourly/burst)   → delay/requeue if over effective rate
  ├─ 9. Deliver
  └─ 10. On delivered: consume credit + emit delivery event → reputation engine
```

Existing `checkRateLimit()` in `services/gateway/src/lib/rate-limit.ts` is replaced by the Phase 1 policy-aware limiter; Phase 3 adds worker-side pacing at effective rate.

---

## 8. Timeline summary

| Phase | Duration | Cumulative | Milestone |
|-------|----------|------------|-----------|
| 0 — Prerequisites | 1–2 wk | 2 wk | Live bounces, complaints, Track 4 |
| 1 — Policies & credits | 2–3 wk | 5 wk | Entitlement enforcement |
| 2 — Reputation engine | 3–4 wk | 9 wk | Continuous 0–100 score |
| 3 — Dynamic throughput | 2–3 wk | 12 wk | Multipliers + warm-up + ETA |
| 4 — Campaign health & guidance | 2 wk | 14 wk | UX transparency |
| 5 — Infra protection | 2 wk | 16 wk | Platform stability |
| 6 — Enterprise | ongoing | — | IP pools, scale, docs |

**Recommended start:** Phase 0 in parallel with OCI deploy. Phase 1 can begin locally against Mailpit (credits/limits don't need real SMTP).

---

## 9. Risks & decisions

| Risk | Mitigation |
|------|------------|
| Credit double-charge on retry | Reserve once at accept; consume once on `delivered` only |
| Reputation oscillation | Smoothing factor + max delta per event |
| LiteDesk/AMDS credit drift | Periodic reconciliation job; AMDS ledger is consumption truth |
| Warm-up vs IP warm-up confusion | **Tenant warm-up** (PDF) = per-tenant throughput ramp; **IP warm-up** (existing runbook) = egress IP volume — implement both in Phase 3/5 |
| Transactional starvation | Separate queue floors; never block helpdesk below minimum rate |
| Complaint signal missing locally | Use simulation in CI until FBL live |

### Open decisions (need product sign-off)

1. **Initial reputation score** for new tenants (suggest 70).
2. **Credit refund policy** on hard bounce after delivery attempt.
3. **Admin suspend at < 20** — auto or alert-only?
4. **Reputation enabled flag** — when false, use 100% multiplier but still track metrics?

---

## 10. Success criteria

| Metric | Target |
|--------|--------|
| Credit accuracy | 100% match between reserved and delivered counts in load test |
| Reputation latency | Score updates within 5s of bounce/complaint event |
| Throughput accuracy | Effective rate within 5% of configured formula |
| UX | Campaign composer shows ETA before send |
| Safety | Tenant at reputation 15 cannot send marketing; transactional still works |
| Recovery | Score rises ≤ 5 points/day without positive signals (anti-gaming) |

---

## 11. Relationship to existing roadmap

| Existing item | This roadmap |
|---------------|--------------|
| Track 5 IP warm-up runbook | Phase 5 — automated IP caps |
| Per-tenant rate limit (Track 2) | Phase 1 — replaced by policy sync |
| Analytics API (Track 4) | Phase 4 — extended with health + reputation |
| `message.complained` (missing) | Phase 0 prerequisite |
| Phase 4 dedicated IP pools | Phase 6 |
| LiteDesk Track 4 | Phase 0 prerequisite |

---

*Last updated: July 2, 2026*
