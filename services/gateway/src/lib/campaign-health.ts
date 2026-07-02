import type { Pool } from 'pg';
import { calculateCampaignHealthScore, type CampaignHealthCalculation } from '@vmds/shared';

export interface CampaignHealthResult extends CampaignHealthCalculation {
  tenant_id: string;
  campaign_id: string;
  message_count: number;
}

export async function getCampaignHealth(
  pool: Pool,
  tenantId: string,
  campaignExternalId: string
): Promise<CampaignHealthResult | null> {
  const campaign = await pool.query(
    `SELECT id, message_count FROM campaigns
     WHERE tenant_id = $1 AND external_id = $2`,
    [tenantId, campaignExternalId]
  );

  if (campaign.rows.length === 0) {
    return null;
  }

  const campaignUuid = campaign.rows[0].id as string;

  const statusResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE m.status = 'delivered')::int AS delivered,
       COUNT(*) FILTER (WHERE m.status = 'bounced')::int AS bounced
     FROM messages m
     WHERE m.tenant_id = $1 AND m.campaign_id = $2`,
    [tenantId, campaignUuid]
  );

  const bounceResult = await pool.query(
    `SELECT
       COUNT(DISTINCT me.message_id) FILTER (
         WHERE me.detail->>'classification' = 'hard'
       )::int AS hard_bounced,
       COUNT(DISTINCT me.message_id) FILTER (
         WHERE me.detail->>'classification' = 'soft'
       )::int AS soft_bounced
     FROM message_events me
     JOIN messages m ON m.id = me.message_id
     WHERE m.tenant_id = $1
       AND m.campaign_id = $2
       AND me.event_type = 'bounced'`,
    [tenantId, campaignUuid]
  );

  const complaintResult = await pool.query(
    `SELECT COUNT(DISTINCT me.message_id)::int AS complaints
     FROM message_events me
     JOIN messages m ON m.id = me.message_id
     WHERE m.tenant_id = $1
       AND m.campaign_id = $2
       AND me.event_type = 'complained'`,
    [tenantId, campaignUuid]
  );

  const trackingResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE tt.token_type = 'open' AND tt.hit_count > 0)::int AS unique_opens,
       COUNT(*) FILTER (WHERE tt.token_type = 'click' AND tt.hit_count > 0)::int AS unique_clicks
     FROM tracking_tokens tt
     JOIN messages m ON m.id = tt.message_id
     WHERE m.tenant_id = $1 AND m.campaign_id = $2`,
    [tenantId, campaignUuid]
  );

  const statusRow = statusResult.rows[0];
  const bounceRow = bounceResult.rows[0];
  const metrics = {
    total: Number(statusRow.total),
    delivered: Number(statusRow.delivered),
    hardBounced: Number(bounceRow.hard_bounced),
    softBounced: Number(bounceRow.soft_bounced),
    complaints: Number(complaintResult.rows[0].complaints),
    uniqueOpens: Number(trackingResult.rows[0].unique_opens),
    uniqueClicks: Number(trackingResult.rows[0].unique_clicks),
  };

  const calculation = calculateCampaignHealthScore(metrics);

  return {
    tenant_id: tenantId,
    campaign_id: campaignExternalId,
    message_count: Number(campaign.rows[0].message_count),
    ...calculation,
  };
}

export function formatCampaignHealthResponse(result: CampaignHealthResult) {
  return {
    tenant_id: result.tenant_id,
    campaign_id: result.campaign_id,
    message_count: result.message_count,
    score: result.score,
    breakdown: result.breakdown,
    metrics: result.metrics,
    factors: result.factors,
  };
}
