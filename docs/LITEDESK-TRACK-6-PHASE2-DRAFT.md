# LiteDesk Track 6 Phase 2 — Sender Reputation

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 6 Phase 2 complete — see [TRACK-6-PHASE2-COMPLETE.md](./TRACK-6-PHASE2-COMPLETE.md)  
**Prerequisite:** [LITEDESK-TRACK-6-PHASE1-DRAFT.md](./LITEDESK-TRACK-6-PHASE1-DRAFT.md) (policy sync)

Build in parallel with AMDS Phase 2. Phase 3 adds effective throughput + ETA UI.

---

## 1. Goal

Display and cache **sender reputation (0–100)** from AMDS. React to `reputation.updated` webhooks. Do not let tenants edit the score — admin override is AMDS platform-admin only.

---

## 2. Files to add or modify

| File | Action |
|------|--------|
| `server/models/org-email-policy.js` | Add `senderReputation`, `reputationUpdatedAt` |
| `server/services/amds/amds-types.ts` | Reputation + webhook types |
| `server/services/amds/amds-client.ts` | `getTenantReputation`, `getReputationHistory` |
| `server/services/amds/handlers/tenant-event-handler.ts` | Handle `reputation.updated` |
| `server/services/amds/handlers/communication-event-handler.ts` | Handle `message.complained` |
| `server/routes/settings/email-policy.js` | Include reputation in GET response |
| `client/src/views/settings/EmailPolicy.vue` | Reputation score card |
| `server/scripts/validate-amds-track6-phase2.js` | E2E reputation sync test |

---

## 3. Extend MongoDB model

```javascript
// Add to orgEmailPolicySchema
senderReputation: { type: Number, default: null, min: 0, max: 100 },
reputationPreviousScore: { type: Number, default: null },
reputationDelta: { type: Number, default: null },
reputationFactors: { type: [mongoose.Schema.Types.Mixed], default: [] },
reputationUpdatedAt: { type: Date, default: null },
```

---

## 4. Types

```typescript
export interface TenantReputationResponse {
  tenant_id: string;
  score: number;
  previous_score: number;
  delta: number;
  breakdown: Record<string, { rate: number | null; score: number; weight: number }>;
  metrics: Record<string, number>;
  admin_override: boolean;
  override_reason: string | null;
  updated_at: string;
}

export interface ReputationUpdatedWebhook {
  event_type: 'reputation.updated';
  tenant_id: string;
  reputation: {
    score: number;
    previous_score: number;
    delta: number;
    factors: Array<{ signal: string; impact: string; message: string }>;
    trigger_signal?: string;
  };
}
```

---

## 5. AMDS client

```typescript
async getTenantReputation(tenantId: string): Promise<TenantReputationResponse> {
  return this.request('GET', `/v1/tenants/${encodeURIComponent(tenantId)}/reputation`);
}

async getReputationHistory(tenantId: string, limit = 30) {
  return this.request(
    'GET',
    `/v1/tenants/${encodeURIComponent(tenantId)}/reputation/history?limit=${limit}`
  );
}
```

Poll `getTenantReputation` on Settings load; prefer webhook cache for live updates.

---

## 6. Webhook handler

```typescript
// tenant-event-handler.ts — add case
case 'reputation.updated': {
  if (!event.reputation) return;
  await OrgEmailPolicy.findOneAndUpdate(
    { orgId: event.tenant_id },
    {
      senderReputation: event.reputation.score,
      reputationPreviousScore: event.reputation.previous_score,
      reputationDelta: event.reputation.delta,
      reputationFactors: event.reputation.factors,
      reputationUpdatedAt: new Date(),
    }
  );
  break;
}
```

### `message.complained`

```typescript
// communication-event-handler.ts — add case
case 'message.complained': {
  await updateCommunicationStatus(event, 'complained');
  await suppressContact(event, 'complaint');
  break;
}
```

---

## 7. Settings UI

```vue
<section v-if="policy.senderReputation != null" class="reputation-card">
  <h3>Sender reputation</h3>
  <p class="score">{{ policy.senderReputation }} / 100</p>
  <p v-if="policy.reputationDelta" :class="deltaClass">
    {{ policy.reputationDelta > 0 ? '▲' : '▼' }}
    {{ Math.abs(policy.reputationDelta) }} since last update
  </p>
  <ul v-if="policy.reputationFactors?.length">
    <li v-for="(f, i) in policy.reputationFactors" :key="i">
      {{ f.impact === 'positive' ? '✓' : '✗' }} {{ f.message }}
    </li>
  </ul>
  <p class="hint">Reputation affects delivery speed, not your credit balance.</p>
</section>
```

Phase 4 adds full guidance panel with recommendations.

---

## 8. Settings API response

Extend `GET /api/settings/email-policy`:

```json
{
  "creditsRemaining": 80000,
  "senderReputation": 86,
  "reputationDelta": 4,
  "reputationFactors": [
    { "signal": "delivery", "impact": "positive", "message": "Strong delivery rate" }
  ],
  "reputationUpdatedAt": "2026-07-02T12:00:00.000Z"
}
```

Optional proxy: `GET /api/settings/email-policy/reputation/history` → AMDS history API.

---

## 9. Checklist

```
[ ] OrgEmailPolicy — reputation cache fields
[ ] amds-client — getTenantReputation, getReputationHistory
[ ] tenant-event-handler — reputation.updated
[ ] communication-event-handler — message.complained
[ ] EmailPolicy.vue — score + delta + factors
[ ] validate-amds-track6-phase2.js
```

---

## 10. Testing

```bash
# AMDS
npm run dev
npm run validate:track-6b

# LiteDesk (after implementation)
node server/scripts/validate-amds-track6-phase2.js
```

Script should: sync policy → send email → verify reputation ≥ 70 → simulate bounce → verify score dropped → webhook updated MongoDB.

---

## 11. Out of scope (Phase 3)

| Feature | Phase |
|---------|-------|
| Effective hourly rate display | Phase 3 |
| Campaign completion ETA | Phase 3 |
| Reputation-based send blocking | Phase 3 |
| Full guidance + recommendations | Phase 4 |

---

**Last updated:** July 2, 2026
