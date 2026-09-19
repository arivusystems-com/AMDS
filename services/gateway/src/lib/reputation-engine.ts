import type { Pool } from 'pg';
import {
  loadConfig,
  calculateReputationScore,
  applyScoreDeltaCap,
  applyDailyRecoveryCap,
  recoveryHeadroom,
  computeConsistencyScore,
  computeAuthScore,
  type ReputationSignalType,
  type ReputationCalculation,
} from '@vmds/shared';
import { dispatchTenantWebhook } from './tenant-webhooks.js';
import { getTenantPolicy } from './tenant-policies.js';
import { refreshTenantThroughput } from './throughput-engine.js';
import { getReadPool } from './db.js';

export interface ReputationRow {
  tenant_id: string;
  score: number;
  previous_score: number;
  breakdown: ReputationCalculation['breakdown'];
  metrics: ReputationCalculation['metrics'];
  admin_override: boolean;
  override_reason: string | null;
  updated_at: Date;
  created_at: Date;
}

function mapReputationRow(row: Record<string, unknown>): ReputationRow {
  return {
    tenant_id: row.tenant_id as string,
    score: Number(row.score),
    previous_score: Number(row.previous_score),
    breakdown: row.breakdown as ReputationRow['breakdown'],
    metrics: row.metrics as ReputationRow['metrics'],
    admin_override: Boolean(row.admin_override),
    override_reason: (row.override_reason as string | null) ?? null,
    updated_at: new Date(row.updated_at as string),
    created_at: new Date(row.created_at as string),
  };
}

export async function ensureTenantReputation(
  pool: Pool,
  tenantId: string
): Promise<ReputationRow> {
  const config = loadConfig();
  const existing = await pool.query(`SELECT * FROM tenant_reputation WHERE tenant_id = $1`, [
    tenantId,
  ]);
  if (existing.rows.length > 0) {
    return mapReputationRow(existing.rows[0]);
  }

  const inserted = await pool.query(
    `INSERT INTO tenant_reputation (tenant_id, score, previous_score)
     VALUES ($1, $2, $2)
     ON CONFLICT (tenant_id) DO NOTHING
     RETURNING *`,
    [tenantId, config.REPUTATION_DEFAULT_SCORE]
  );

  if (inserted.rows.length > 0) {
    return mapReputationRow(inserted.rows[0]);
  }

  const refetch = await pool.query(`SELECT * FROM tenant_reputation WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return mapReputationRow(refetch.rows[0]);
}

async function aggregateMetrics(pool: Pool, tenantId: string) {
  const counts = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE signal_type = 'delivered' AND created_at >= NOW() - INTERVAL '30 days')::int AS delivered_30d,
       COUNT(*) FILTER (WHERE signal_type = 'hard_bounce' AND created_at >= NOW() - INTERVAL '30 days')::int AS hard_bounce_30d,
       COUNT(*) FILTER (WHERE signal_type = 'soft_bounce' AND created_at >= NOW() - INTERVAL '30 days')::int AS soft_bounce_30d,
       COUNT(*) FILTER (WHERE signal_type = 'complaint' AND created_at >= NOW() - INTERVAL '7 days')::int AS complaint_7d,
       COUNT(*) FILTER (WHERE signal_type = 'delivered' AND created_at >= NOW() - INTERVAL '7 days')::int AS delivered_7d,
       COUNT(DISTINCT message_id) FILTER (WHERE signal_type = 'open' AND created_at >= NOW() - INTERVAL '30 days')::int AS open_30d,
       COUNT(DISTINCT message_id) FILTER (WHERE signal_type = 'click' AND created_at >= NOW() - INTERVAL '30 days')::int AS click_30d
     FROM reputation_signals
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const daily = await pool.query(
    `SELECT DATE(created_at AT TIME ZONE 'UTC') AS day, COUNT(*)::int AS count
     FROM reputation_signals
     WHERE tenant_id = $1
       AND signal_type = 'delivered'
       AND created_at >= NOW() - INTERVAL '14 days'
     GROUP BY 1
     ORDER BY 1`,
    [tenantId]
  );

  const domains = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE spf_verified AND dkim_verified AND dmarc_verified)::int AS full_auth,
       COUNT(*) FILTER (WHERE (spf_verified OR dkim_verified OR dmarc_verified)
         AND NOT (spf_verified AND dkim_verified AND dmarc_verified))::int AS partial_auth
     FROM domains
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const row = counts.rows[0];
  const domainRow = domains.rows[0] ?? { total: 0, full_auth: 0, partial_auth: 0 };

  return {
    delivered30d: Number(row.delivered_30d),
    hardBounce30d: Number(row.hard_bounce_30d),
    softBounce30d: Number(row.soft_bounce_30d),
    complaint7d: Number(row.complaint_7d),
    delivered7d: Number(row.delivered_7d),
    open30d: Number(row.open_30d),
    click30d: Number(row.click_30d),
    consistencyScore: computeConsistencyScore(daily.rows.map((r) => Number(r.count))),
    authScore: computeAuthScore({
      totalDomains: Number(domainRow.total),
      fullyVerifiedDomains: Number(domainRow.full_auth),
      partiallyVerifiedDomains: Number(domainRow.partial_auth),
    }),
  };
}

async function getDayStartScore(pool: Pool, tenantId: string, fallback: number): Promise<number> {
  const result = await pool.query(
    `SELECT score FROM reputation_history
     WHERE tenant_id = $1
       AND created_at < date_trunc('day', NOW() AT TIME ZONE 'UTC')
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId]
  );

  if (result.rows.length > 0) {
    return Number(result.rows[0].score);
  }

  const todayFirst = await pool.query(
    `SELECT previous_score FROM reputation_history
     WHERE tenant_id = $1
       AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
     ORDER BY created_at ASC
     LIMIT 1`,
    [tenantId]
  );

  if (todayFirst.rows.length > 0) {
    return Number(todayFirst.rows[0].previous_score);
  }

  return fallback;
}

export async function recalculateTenantReputation(
  pool: Pool,
  tenantId: string,
  trigger?: { signal: ReputationSignalType; messageId?: string }
): Promise<ReputationRow | null> {
  const policy = await getTenantPolicy(pool, tenantId);
  if (policy && !policy.reputation_enabled) {
    return null;
  }

  const config = loadConfig();
  const current = await ensureTenantReputation(pool, tenantId);
  if (current.admin_override) {
    return current;
  }

  const signalCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM reputation_signals WHERE tenant_id = $1`,
    [tenantId]
  );
  if (Number(signalCount.rows[0].count) === 0) {
    return current;
  }

  const metrics = await aggregateMetrics(pool, tenantId);
  const calculation = calculateReputationScore(metrics);
  const eventCapped = applyScoreDeltaCap(
    current.score,
    calculation.score,
    config.REPUTATION_MAX_DELTA
  );
  const dayStartScore = await getDayStartScore(pool, tenantId, current.score);
  const cappedScore = applyDailyRecoveryCap(
    eventCapped,
    dayStartScore,
    config.REPUTATION_MAX_DAILY_GAIN
  );
  const delta = Math.round((cappedScore - current.score) * 100) / 100;

  if (Math.abs(delta) < 0.01 && trigger === undefined) {
    return current;
  }

  const updated = await pool.query(
    `UPDATE tenant_reputation
     SET score = $2,
         previous_score = $3,
         breakdown = $4,
         metrics = $5,
         updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [
      tenantId,
      cappedScore,
      current.score,
      JSON.stringify(calculation.breakdown),
      JSON.stringify(calculation.metrics),
    ]
  );

  await pool.query(
    `INSERT INTO reputation_history (
       tenant_id, score, previous_score, delta, breakdown, factors, trigger_signal, trigger_message_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenantId,
      cappedScore,
      current.score,
      delta,
      JSON.stringify(calculation.breakdown),
      JSON.stringify(calculation.factors),
      trigger?.signal ?? null,
      trigger?.messageId ?? null,
    ]
  );

  const row = mapReputationRow(updated.rows[0]);

  if (Math.abs(delta) >= 0.01) {
    try {
      await dispatchTenantWebhook({
        event_type: 'reputation.updated',
        tenant_id: tenantId,
        message_id: trigger?.messageId,
        reputation: {
          score: row.score,
          previous_score: current.score,
          delta,
          factors: calculation.factors,
          trigger_signal: trigger?.signal,
        },
      });
    } catch {
      // score persisted
    }
  }

  void refreshTenantThroughput(pool, tenantId, { notify: true });

  return row;
}

export async function recordReputationSignal(
  pool: Pool,
  input: {
    tenantId: string;
    messageId?: string;
    signalType: ReputationSignalType;
    detail?: Record<string, unknown>;
  }
): Promise<ReputationRow | null> {
  const policy = await getTenantPolicy(pool, input.tenantId);
  if (policy && !policy.reputation_enabled) {
    return null;
  }

  if (input.signalType === 'blacklist' || input.signalType === 'spam_trap') {
    return applyNegativeReputationSignal(pool, {
      tenantId: input.tenantId,
      messageId: input.messageId,
      signalType: input.signalType,
      detail: input.detail,
    });
  }

  await pool.query(
    `INSERT INTO reputation_signals (tenant_id, message_id, signal_type, detail)
     VALUES ($1, $2, $3, $4)`,
    [
      input.tenantId,
      input.messageId ?? null,
      input.signalType,
      input.detail ? JSON.stringify(input.detail) : null,
    ]
  );

  return recalculateTenantReputation(pool, input.tenantId, {
    signal: input.signalType,
    messageId: input.messageId,
  });
}

export async function applyNegativeReputationSignal(
  pool: Pool,
  input: {
    tenantId: string;
    messageId?: string;
    signalType: 'blacklist' | 'spam_trap';
    detail?: Record<string, unknown>;
  }
): Promise<ReputationRow> {
  const config = loadConfig();
  const current = await ensureTenantReputation(pool, input.tenantId);
  const penalty =
    input.signalType === 'blacklist'
      ? config.REPUTATION_BLACKLIST_PENALTY
      : config.REPUTATION_SPAM_TRAP_PENALTY;

  await pool.query(
    `INSERT INTO reputation_signals (tenant_id, message_id, signal_type, detail)
     VALUES ($1, $2, $3, $4)`,
    [
      input.tenantId,
      input.messageId ?? null,
      input.signalType,
      input.detail ? JSON.stringify(input.detail) : null,
    ]
  );

  const proposed = Math.max(0, current.score - penalty);
  const capped = applyScoreDeltaCap(current.score, proposed, config.REPUTATION_MAX_DELTA);
  const delta = Math.round((capped - current.score) * 100) / 100;

  const updated = await pool.query(
    `UPDATE tenant_reputation
     SET score = $2,
         previous_score = $3,
         admin_override = false,
         override_reason = NULL,
         updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [input.tenantId, capped, current.score]
  );

  await pool.query(
    `INSERT INTO reputation_history (
       tenant_id, score, previous_score, delta, breakdown, factors, trigger_signal, trigger_message_id
     ) VALUES ($1,$2,$3,$4,'{}',$5,$6,$7)`,
    [
      input.tenantId,
      capped,
      current.score,
      delta,
      JSON.stringify([
        {
          signal: input.signalType,
          impact: 'negative',
          message: `${input.signalType === 'blacklist' ? 'Blacklist' : 'Spam trap'} signal recorded`,
        },
      ]),
      input.signalType,
      input.messageId ?? null,
    ]
  );

  const row = mapReputationRow(updated.rows[0]);
  void refreshTenantThroughput(pool, input.tenantId, { notify: true });
  return row;
}

export async function getReputationRecoveryInfo(
  pool: Pool,
  tenantId: string,
  currentScore: number
) {
  const config = loadConfig();
  const dayStartScore = await getDayStartScore(pool, tenantId, currentScore);
  return {
    day_start_score: dayStartScore,
    max_score_today: dayStartScore + config.REPUTATION_MAX_DAILY_GAIN,
    remaining_gain_today: recoveryHeadroom(
      currentScore,
      dayStartScore,
      config.REPUTATION_MAX_DAILY_GAIN
    ),
  };
}

export async function getTenantReputation(
  pool: Pool,
  tenantId: string
): Promise<ReputationRow> {
  return ensureTenantReputation(pool, tenantId);
}

export async function getReputationHistory(
  pool: Pool,
  tenantId: string,
  limit: number
) {
  const readPool = getReadPool();
  const result = await readPool.query(
    `SELECT id, tenant_id, score, previous_score, delta, breakdown, factors,
            trigger_signal, trigger_message_id, created_at
     FROM reputation_history
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}

export async function adminOverrideReputation(
  pool: Pool,
  tenantId: string,
  score: number,
  reason: string
): Promise<ReputationRow> {
  await ensureTenantReputation(pool, tenantId);
  const current = await getTenantReputation(pool, tenantId);
  const delta = Math.round((score - current.score) * 100) / 100;

  const updated = await pool.query(
    `UPDATE tenant_reputation
     SET score = $2,
         previous_score = $3,
         admin_override = true,
         override_reason = $4,
         updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [tenantId, score, current.score, reason]
  );

  await pool.query(
    `INSERT INTO reputation_events (tenant_id, event_type, detail)
     VALUES ($1, 'admin_override', $2)`,
    [tenantId, JSON.stringify({ score, reason, previous_score: current.score })]
  );

  await pool.query(
    `INSERT INTO reputation_history (
       tenant_id, score, previous_score, delta, breakdown, factors, trigger_signal
     ) VALUES ($1,$2,$3,$4,'{}','[]','admin_override')`,
    [tenantId, score, current.score, delta]
  );

  const row = mapReputationRow(updated.rows[0]);
  void refreshTenantThroughput(pool, tenantId, { notify: true });
  return row;
}

export function formatReputationResponse(row: ReputationRow) {
  return {
    tenant_id: row.tenant_id,
    score: row.score,
    previous_score: row.previous_score,
    delta: Math.round((row.score - row.previous_score) * 100) / 100,
    breakdown: row.breakdown,
    metrics: row.metrics,
    admin_override: row.admin_override,
    override_reason: row.override_reason,
    updated_at: row.updated_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}
