# LiteDesk Track 6 Phase 3 — Dynamic Throughput & Campaign ETA

**Audience:** LiteDesk backend + frontend developers  
**AMDS dependency:** Track 6 Phase 3 — see [TRACK-6-PHASE3-COMPLETE.md](./TRACK-6-PHASE3-COMPLETE.md)  
**Prerequisite:** Phase 1 policy sync + Phase 2 reputation display

---

## 1. Goal

Show users **how fast** mail will send (effective rate + ETA), not just credits and reputation. Block marketing sends when reputation < 40.

---

## 2. Files to modify

| File | Action |
|------|--------|
| `server/services/amds/amds-client.ts` | `getTenantThroughput`, `getCampaignEstimate` |
| `server/services/amds/amds-types.ts` | Throughput + estimate types |
| `server/services/amds/handlers/tenant-event-handler.ts` | `throughput.updated` webhook |
| `server/models/org-email-policy.js` | Cache effective rates |
| `client/src/views/marketing/CampaignComposer.vue` | ETA + effective rate UI |
| `client/src/views/settings/EmailPolicy.vue` | Throughput card |
| `server/services/marketing/sendCampaign.js` | Pre-check reputation ≥ 40 |

---

## 3. Types

```typescript
export interface TenantThroughputResponse {
  tenant_id: string;
  max_hourly_rate: number;
  max_burst_rate: number;
  effective_hourly_rate: number;
  effective_burst_rate: number;
  multipliers: {
    reputation: number;
    warmup: number;
    infra: number;
    combined: number;
    warmup_stage: string;
  };
  reputation_score: number;
  updated_at: string;
}

export interface CampaignEstimateResponse {
  campaign_id: string;
  tenant_id: string;
  recipient_count: number;
  throughput: TenantThroughputResponse;
  estimated_seconds: number | null;
  estimated_completion: string | null;
}
```

---

## 4. AMDS client

```typescript
async getTenantThroughput(tenantId: string): Promise<TenantThroughputResponse> {
  return this.request('GET', `/v1/tenants/${encodeURIComponent(tenantId)}/throughput`);
}

async getCampaignEstimate(
  tenantId: string,
  campaignId: string,
  recipientCount: number
): Promise<CampaignEstimateResponse> {
  const qs = new URLSearchParams({
    tenant_id: tenantId,
    recipient_count: String(recipientCount),
  });
  return this.request('GET', `/v1/campaigns/${encodeURIComponent(campaignId)}/estimate?${qs}`);
}
```

---

## 5. Webhook — `throughput.updated`

```typescript
case 'throughput.updated': {
  if (!event.throughput) return;
  await OrgEmailPolicy.findOneAndUpdate(
    { orgId: event.tenant_id },
    {
      effectiveHourlyRate: event.throughput.effective_hourly_rate,
      effectiveBurstRate: event.throughput.effective_burst_rate,
      warmupStage: event.throughput.multipliers.warmup_stage,
      throughputUpdatedAt: new Date(),
    }
  );
  break;
}
```

---

## 6. Campaign composer UI

Before send, fetch estimate:

```typescript
const estimate = await amdsClient.getCampaignEstimate(orgId, campaignId, recipients.length);
```

Display:

```text
Recipients:              25,000
Credits required:        25,000
Credits remaining:       80,000
Sender reputation:       86 / 100
Max hourly rate:         5,000 / hour
Current effective rate:  3,750 / hour
Estimated completion:    6 hours 40 minutes
```

Disable **Send** when `senderReputation < 40` with message:  
*"Marketing campaigns require sender reputation of at least 40."*

---

## 7. Marketing send guard

```javascript
const policy = await OrgEmailPolicy.findOne({ orgId });
if (policy.reputationEnabled && (policy.senderReputation ?? 0) < 40) {
  throw new AppError('marketing_restricted', 'Sender reputation too low for marketing sends', 403);
}
```

Handle AMDS `403 marketing_restricted` as fallback.

---

## 8. Settings throughput card

```vue
<dl>
  <dt>Max hourly rate</dt>
  <dd>{{ policy.maxHourlyRate }}/hour</dd>
  <dt>Effective rate</dt>
  <dd>{{ policy.effectiveHourlyRate }}/hour</dd>
  <dt>Warm-up stage</dt>
  <dd>{{ policy.warmupStage ?? '—' }}</dd>
</dl>
<p class="hint">Effective rate = max rate × reputation × warm-up × infrastructure.</p>
```

---

## 9. Checklist

```
[ ] amds-client — getTenantThroughput, getCampaignEstimate
[ ] tenant-event-handler — throughput.updated
[ ] OrgEmailPolicy — effectiveHourlyRate, warmupStage cache
[ ] CampaignComposer — ETA + effective rate
[ ] Marketing send — reputation ≥ 40 pre-check
[ ] EmailPolicy settings — throughput display
```

---

## 10. Testing

```bash
# AMDS
npm run validate:track-6c

# LiteDesk (after implementation)
# 1. Sync policy with max_hourly_rate 5000
# 2. Set reputation 82 via AMDS admin or good sends
# 3. GET throughput proxy → effective 3750
# 4. Campaign composer shows ETA for 25k recipients
# 5. Reputation 35 → send button disabled
```

---

**Last updated:** July 2, 2026
