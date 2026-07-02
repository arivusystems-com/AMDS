# LiteDesk Track 6 Phase 4 — Campaign Health & Reputation Guidance

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 6 Phase 4 — see [TRACK-6-PHASE4-COMPLETE.md](./TRACK-6-PHASE4-COMPLETE.md)  
**Prerequisite:** Phase 1 policy sync, Phase 2 reputation display, Phase 3 throughput/ETA

---

## 1. Goal

Show users **why** reputation changed and how a **specific campaign** performed — separately from tenant sender reputation.

---

## 2. Files to modify

| File | Action |
|------|--------|
| `server/services/amds/amds-client.ts` | `getCampaignHealth`, `getReputationGuidance` |
| `server/services/amds/amds-types.ts` | Health + guidance response types |
| `client/src/views/marketing/CampaignDetail.vue` | Campaign health badge + metrics |
| `client/src/views/settings/EmailReputation.vue` | Guidance panel (reasons + recommendations) |
| `client/src/views/marketing/CampaignComposer.vue` | Show campaign health preview after send |

---

## 3. Types

```typescript
export interface CampaignHealthResponse {
  tenant_id: string;
  campaign_id: string;
  message_count: number;
  score: number;
  breakdown: Record<string, { rate: number | null; score: number; weight: number }>;
  metrics: {
    total: number;
    delivered: number;
    hardBounced: number;
    softBounced: number;
    complaints: number;
    uniqueOpens: number;
    uniqueClicks: number;
  };
  factors: Array<{ signal: string; impact: 'positive' | 'negative' | 'neutral'; message: string }>;
}

export interface ReputationGuidanceResponse {
  tenant_id: string;
  score: number;
  previous_score: number;
  delta: number;
  breakdown: Record<string, unknown>;
  reasons: Array<{
    signal: string;
    status: 'passed' | 'warning' | 'failed';
    message: string;
    score: number;
    previous_score?: number;
    delta?: number;
  }>;
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    category: string;
    message: string;
  }>;
  updated_at: string;
}
```

---

## 4. AMDS client methods

```typescript
async getCampaignHealth(campaignId: string, tenantId: string): Promise<CampaignHealthResponse> {
  return this.get(`/v1/campaigns/${campaignId}/health`, { tenant_id: tenantId });
}

async getReputationGuidance(tenantId: string): Promise<ReputationGuidanceResponse> {
  return this.get(`/v1/tenants/${tenantId}/reputation/guidance`);
}
```

---

## 5. UI — Campaign detail

Display side-by-side:

| Metric | Source |
|--------|--------|
| Sender reputation | `GET /v1/tenants/:id/reputation` |
| Campaign health | `GET /v1/campaigns/:id/health` |

Use color bands:

- **80+** green
- **60–79** amber
- **< 60** red

Show `factors` as bullet list under campaign health score.

---

## 6. UI — Settings → Email reputation

Add **Guidance** panel below the reputation score card:

1. Fetch `GET /v1/tenants/:id/reputation/guidance` on page load.
2. Render `reasons` with icons:
   - `passed` → ✓
   - `warning` → ⚠
   - `failed` → ✗
3. Render `recommendations` grouped by `priority` (high first).

Refresh guidance when `reputation.updated` webhook fires.

---

## 7. Analytics integration

`GET /v1/analytics/summary?tenant_id=&campaign_id=` now includes:

```json
{
  "reputation": { "score": 72, "previous_score": 75, "delta": -3 },
  "campaign_health": { "score": 68, "factors": [...] },
  "counts": { "complaints": 1, ... },
  "rates": { "complaint_rate": 0.33, "hard_bounce_rate": 0.33, ... }
}
```

Use in campaign analytics dashboard widgets.

---

## 8. Acceptance criteria

- [ ] Campaign detail shows health score independent of sender reputation
- [ ] Settings page shows guidance reasons after a bounce or complaint event
- [ ] High-priority recommendations surfaced when score < 40
- [ ] Analytics dashboard includes complaint and hard bounce rates

---

*Draft — July 2, 2026*
