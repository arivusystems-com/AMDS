import type { Pool } from 'pg';
import { getTenantReputation } from './reputation-engine.js';
import { getCampaignHealth } from './campaign-health.js';

export interface AnalyticsSummary {
  tenant_id: string;
  campaign_id: string | null;
  period: { from: string | null; to: string | null };
  counts: {
    total: number;
    queued: number;
    scheduled: number;
    processing: number;
    delivered: number;
    failed: number;
    bounced: number;
    dead_letter: number;
    complaints: number;
    unique_opens: number;
    unique_clicks: number;
    total_opens: number;
    total_clicks: number;
  };
  rates: {
    delivery_rate: number;
    open_rate: number;
    click_rate: number;
    complaint_rate: number;
    hard_bounce_rate: number;
  };
  reputation?: {
    score: number;
    previous_score: number;
    delta: number;
  };
  campaign_health?: {
    score: number;
    factors: Array<{ signal: string; impact: string; message: string }>;
  };
}

export async function getAnalyticsSummary(
  pool: Pool,
  query: {
    tenantId: string;
    campaignExternalId?: string;
    from?: string;
    to?: string;
    includeReputation?: boolean;
  }
): Promise<AnalyticsSummary> {
  const { tenantId, campaignExternalId, from, to } = query;

  const params: unknown[] = [tenantId];
  let campaignJoin = '';
  let dateFilter = '';

  if (campaignExternalId) {
    params.push(campaignExternalId);
    campaignJoin = `JOIN campaigns c ON c.id = m.campaign_id AND c.external_id = $${params.length}`;
  }

  if (from) {
    params.push(from);
    dateFilter += ` AND m.created_at >= $${params.length}::timestamptz`;
  }

  if (to) {
    params.push(to);
    dateFilter += ` AND m.created_at <= $${params.length}::timestamptz`;
  }

  const statusResult = await pool.query(
    `SELECT m.status, COUNT(*)::int AS count
     FROM messages m
     ${campaignJoin}
     WHERE m.tenant_id = $1${dateFilter}
     GROUP BY m.status`,
    params
  );

  const counts = {
    total: 0,
    queued: 0,
    scheduled: 0,
    processing: 0,
    delivered: 0,
    failed: 0,
    bounced: 0,
    dead_letter: 0,
    complaints: 0,
    unique_opens: 0,
    unique_clicks: 0,
    total_opens: 0,
    total_clicks: 0,
  };

  for (const row of statusResult.rows) {
    const status = row.status as keyof typeof counts;
    if (status in counts && status !== 'total') {
      counts[status] = row.count;
    }
    counts.total += row.count;
  }

  const complaintParams: unknown[] = [tenantId];
  let complaintJoin = '';
  let complaintDateFilter = '';

  if (campaignExternalId) {
    complaintParams.push(campaignExternalId);
    complaintJoin = `JOIN messages m ON m.id = me.message_id
                     JOIN campaigns c ON c.id = m.campaign_id AND c.external_id = $${complaintParams.length}`;
  } else {
    complaintJoin = `JOIN messages m ON m.id = me.message_id`;
  }

  if (from) {
    complaintParams.push(from);
    complaintDateFilter += ` AND m.created_at >= $${complaintParams.length}::timestamptz`;
  }

  if (to) {
    complaintParams.push(to);
    complaintDateFilter += ` AND m.created_at <= $${complaintParams.length}::timestamptz`;
  }

  const complaintResult = await pool.query(
    `SELECT COUNT(DISTINCT me.message_id)::int AS complaints
     FROM message_events me
     ${complaintJoin}
     WHERE me.event_type = 'complained'
       AND m.tenant_id = $1${complaintDateFilter}`,
    complaintParams
  );
  counts.complaints = Number(complaintResult.rows[0]?.complaints ?? 0);

  const trackingParams: unknown[] = [tenantId];
  let trackingJoin = '';
  let trackingDateFilter = '';

  if (campaignExternalId) {
    trackingParams.push(campaignExternalId);
    trackingJoin = `JOIN messages m ON m.id = tt.message_id
                     JOIN campaigns c ON c.id = m.campaign_id AND c.external_id = $${trackingParams.length}`;
  } else {
    trackingJoin = `JOIN messages m ON m.id = tt.message_id`;
  }

  if (from) {
    trackingParams.push(from);
    trackingDateFilter += ` AND m.created_at >= $${trackingParams.length}::timestamptz`;
  }

  if (to) {
    trackingParams.push(to);
    trackingDateFilter += ` AND m.created_at <= $${trackingParams.length}::timestamptz`;
  }

  const trackingResult = await pool.query(
    `SELECT tt.token_type,
            COUNT(*) FILTER (WHERE tt.hit_count > 0)::int AS unique_hits,
            COALESCE(SUM(tt.hit_count), 0)::int AS total_hits
     FROM tracking_tokens tt
     ${trackingJoin}
     WHERE tt.tenant_id = $1${trackingDateFilter}
     GROUP BY tt.token_type`,
    trackingParams
  );

  for (const row of trackingResult.rows) {
    if (row.token_type === 'open') {
      counts.unique_opens = row.unique_hits;
      counts.total_opens = row.total_hits;
    } else if (row.token_type === 'click') {
      counts.unique_clicks = row.unique_hits;
      counts.total_clicks = row.total_hits;
    }
  }

  const hardBounceParams: unknown[] = [tenantId];
  let hardBounceJoin = '';
  let hardBounceDateFilter = '';

  if (campaignExternalId) {
    hardBounceParams.push(campaignExternalId);
    hardBounceJoin = `JOIN messages m ON m.id = me.message_id
                      JOIN campaigns c ON c.id = m.campaign_id AND c.external_id = $${hardBounceParams.length}`;
  } else {
    hardBounceJoin = `JOIN messages m ON m.id = me.message_id`;
  }

  if (from) {
    hardBounceParams.push(from);
    hardBounceDateFilter += ` AND m.created_at >= $${hardBounceParams.length}::timestamptz`;
  }

  if (to) {
    hardBounceParams.push(to);
    hardBounceDateFilter += ` AND m.created_at <= $${hardBounceParams.length}::timestamptz`;
  }

  const hardBounceResult = await pool.query(
    `SELECT COUNT(DISTINCT me.message_id)::int AS hard_bounced
     FROM message_events me
     ${hardBounceJoin}
     WHERE me.event_type = 'bounced'
       AND me.detail->>'classification' = 'hard'
       AND m.tenant_id = $1${hardBounceDateFilter}`,
    hardBounceParams
  );
  const hardBounced = Number(hardBounceResult.rows[0]?.hard_bounced ?? 0);

  const delivered = counts.delivered;
  const sendAttempts = Math.max(delivered + counts.bounced, counts.total, 1);
  const deliveryRate = counts.total > 0 ? delivered / counts.total : 0;
  const openRate = delivered > 0 ? counts.unique_opens / delivered : 0;
  const clickRate = delivered > 0 ? counts.unique_clicks / delivered : 0;
  const complaintRate = delivered > 0 ? counts.complaints / delivered : 0;
  const hardBounceRate = hardBounced / sendAttempts;

  const summary: AnalyticsSummary = {
    tenant_id: tenantId,
    campaign_id: campaignExternalId ?? null,
    period: { from: from ?? null, to: to ?? null },
    counts,
    rates: {
      delivery_rate: Math.round(deliveryRate * 10000) / 10000,
      open_rate: Math.round(openRate * 10000) / 10000,
      click_rate: Math.round(clickRate * 10000) / 10000,
      complaint_rate: Math.round(complaintRate * 10000) / 10000,
      hard_bounce_rate: Math.round(hardBounceRate * 10000) / 10000,
    },
  };

  if (query.includeReputation !== false) {
    try {
      const reputation = await getTenantReputation(pool, tenantId);
      summary.reputation = {
        score: reputation.score,
        previous_score: reputation.previous_score,
        delta: Math.round((reputation.score - reputation.previous_score) * 100) / 100,
      };
    } catch {
      // tenant may not have reputation row yet
    }
  }

  if (campaignExternalId) {
    const health = await getCampaignHealth(pool, tenantId, campaignExternalId);
    if (health) {
      summary.campaign_health = {
        score: health.score,
        factors: health.factors,
      };
    }
  }

  return summary;
}
