import type { Pool } from 'pg';
import {
  loadConfig,
  reputationMultiplier,
  warmupMultiplier,
  infraMultiplier,
  computeEffectiveRate,
  type ThroughputSnapshot,
} from '@vmds/shared';
import { getTenantPolicy, type TenantPolicyRow } from './tenant-policies.js';
import { getTenantReputation } from './reputation-engine.js';
import { dispatchTenantWebhook } from './tenant-webhooks.js';
import { getQueue } from './queue.js';
import { getCampaignQueue } from './campaign-queue.js';
import { resolveInfraMultiplier } from './infra-state.js';

export interface ThroughputRow {
  tenant_id: string;
  max_hourly_rate: number;
  max_burst_rate: number;
  effective_hourly_rate: number;
  effective_burst_rate: number;
  reputation_multiplier: number;
  warmup_multiplier: number;
  infra_multiplier: number;
  combined_multiplier: number;
  warmup_stage: string;
  reputation_score: number;
  updated_at: Date;
}

function mapRow(row: Record<string, unknown>): ThroughputRow {
  return {
    tenant_id: row.tenant_id as string,
    max_hourly_rate: Number(row.max_hourly_rate),
    max_burst_rate: Number(row.max_burst_rate),
    effective_hourly_rate: Number(row.effective_hourly_rate),
    effective_burst_rate: Number(row.effective_burst_rate),
    reputation_multiplier: Number(row.reputation_multiplier),
    warmup_multiplier: Number(row.warmup_multiplier),
    infra_multiplier: Number(row.infra_multiplier),
    combined_multiplier: Number(row.combined_multiplier),
    warmup_stage: row.warmup_stage as string,
    reputation_score: Number(row.reputation_score),
    updated_at: new Date(row.updated_at as string),
  };
}

async function getInfraQueueDepth(): Promise<number> {
  try {
    const [tx, campaign] = await Promise.all([
      getQueue().getJobCounts('waiting', 'active', 'delayed'),
      getCampaignQueue().getJobCounts('waiting', 'active', 'delayed'),
    ]);
    return (
      (tx.waiting ?? 0) +
      (tx.active ?? 0) +
      (tx.delayed ?? 0) +
      (campaign.waiting ?? 0) +
      (campaign.active ?? 0) +
      (campaign.delayed ?? 0)
    );
  } catch {
    return 0;
  }
}

export function resolveThroughputFromInputs(input: {
  policy: TenantPolicyRow;
  reputationScore: number;
  queueDepth: number;
  queueType?: 'transaction' | 'campaign';
  infraMultiplier?: number;
}): {
  effectiveHourly: number;
  effectiveBurst: number;
  multipliers: ThroughputSnapshot['multipliers'];
} {
  const config = loadConfig();
  const rep = reputationMultiplier(input.reputationScore);
  const warm = warmupMultiplier({
    firstSendAt: input.policy.first_send_at,
    warmupEnabled: input.policy.warmup_enabled,
    reputationScore: input.reputationScore,
    disableReputationScore: config.WARMUP_DISABLE_REPUTATION_SCORE,
    disableMinDays: config.WARMUP_DISABLE_MIN_DAYS,
  });
  const infra =
    input.infraMultiplier ??
    infraMultiplier(input.queueDepth, config.INFRA_QUEUE_DEPTH_THRESHOLD);
  const floor =
    input.queueType === 'transaction' ? config.TRANSACTION_THROUGHPUT_FLOOR : 0;

  const effectiveHourly = computeEffectiveRate(
    input.policy.max_hourly_rate,
    { reputation: rep, warmup: warm.multiplier, infra },
    floor
  );
  const effectiveBurst =
    input.policy.burst_rate_per_min > 0
      ? Math.max(
          1,
          Math.floor(
            input.policy.burst_rate_per_min *
              Math.max(rep * warm.multiplier * infra, floor)
          )
        )
      : 0;

  return {
    effectiveHourly,
    effectiveBurst,
    multipliers: {
      reputation: rep,
      warmup: warm.multiplier,
      infra,
      combined: Math.max(rep * warm.multiplier * infra, floor),
      warmup_stage: warm.stage,
    },
  };
}

export async function refreshTenantThroughput(
  pool: Pool,
  tenantId: string,
  options: { notify?: boolean; queueType?: 'transaction' | 'campaign' } = {}
): Promise<ThroughputRow | null> {
  const policy = await getTenantPolicy(pool, tenantId);
  if (!policy) {
    return null;
  }

  const reputation = await getTenantReputation(pool, tenantId);
  const queueDepth = await getInfraQueueDepth();
  const infraMult = await resolveInfraMultiplier(queueDepth);
  const resolved = resolveThroughputFromInputs({
    policy,
    reputationScore: reputation.score,
    queueDepth,
    queueType: options.queueType,
    infraMultiplier: infraMult,
  });

  const previous = await pool.query(`SELECT * FROM tenant_throughput WHERE tenant_id = $1`, [
    tenantId,
  ]);
  const prevEffective =
    previous.rows.length > 0 ? Number(previous.rows[0].effective_hourly_rate) : null;

  const result = await pool.query(
    `INSERT INTO tenant_throughput (
       tenant_id, max_hourly_rate, max_burst_rate,
       effective_hourly_rate, effective_burst_rate,
       reputation_multiplier, warmup_multiplier, infra_multiplier, combined_multiplier,
       warmup_stage, reputation_score, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       max_hourly_rate = EXCLUDED.max_hourly_rate,
       max_burst_rate = EXCLUDED.max_burst_rate,
       effective_hourly_rate = EXCLUDED.effective_hourly_rate,
       effective_burst_rate = EXCLUDED.effective_burst_rate,
       reputation_multiplier = EXCLUDED.reputation_multiplier,
       warmup_multiplier = EXCLUDED.warmup_multiplier,
       infra_multiplier = EXCLUDED.infra_multiplier,
       combined_multiplier = EXCLUDED.combined_multiplier,
       warmup_stage = EXCLUDED.warmup_stage,
       reputation_score = EXCLUDED.reputation_score,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      policy.max_hourly_rate,
      policy.burst_rate_per_min,
      resolved.effectiveHourly,
      resolved.effectiveBurst,
      resolved.multipliers.reputation,
      resolved.multipliers.warmup,
      resolved.multipliers.infra,
      resolved.multipliers.combined,
      resolved.multipliers.warmup_stage,
      reputation.score,
    ]
  );

  const row = mapRow(result.rows[0]);

  if (
    options.notify !== false &&
    prevEffective !== null &&
    prevEffective !== row.effective_hourly_rate
  ) {
    try {
      await dispatchTenantWebhook({
        event_type: 'throughput.updated',
        tenant_id: tenantId,
        throughput: formatThroughputPayload(row),
      });
    } catch {
      // cached
    }
  }

  return row;
}

export async function getTenantThroughputRow(
  pool: Pool,
  tenantId: string
): Promise<ThroughputRow | null> {
  const existing = await pool.query(`SELECT * FROM tenant_throughput WHERE tenant_id = $1`, [
    tenantId,
  ]);
  if (existing.rows.length > 0) {
    return mapRow(existing.rows[0]);
  }
  return refreshTenantThroughput(pool, tenantId, { notify: false });
}

export function formatThroughputPayload(row: ThroughputRow) {
  return {
    max_hourly_rate: row.max_hourly_rate,
    effective_hourly_rate: row.effective_hourly_rate,
    effective_burst_rate: row.effective_burst_rate,
    multipliers: {
      reputation: row.reputation_multiplier,
      warmup: row.warmup_multiplier,
      infra: row.infra_multiplier,
      combined: row.combined_multiplier,
      warmup_stage: row.warmup_stage,
    },
    reputation_score: row.reputation_score,
  };
}

export function formatThroughputResponse(row: ThroughputRow) {
  return {
    tenant_id: row.tenant_id,
    max_hourly_rate: row.max_hourly_rate,
    max_burst_rate: row.max_burst_rate,
    effective_hourly_rate: row.effective_hourly_rate,
    effective_burst_rate: row.effective_burst_rate,
    multipliers: {
      reputation: row.reputation_multiplier,
      warmup: row.warmup_multiplier,
      infra: row.infra_multiplier,
      combined: row.combined_multiplier,
      warmup_stage: row.warmup_stage,
    },
    reputation_score: row.reputation_score,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getEffectiveLimits(
  pool: Pool,
  tenantId: string,
  options: { queueType?: 'transaction' | 'campaign' } = {}
): Promise<{ hourly: number; burst: number } | null> {
  const policy = await getTenantPolicy(pool, tenantId);
  if (!policy) {
    return null;
  }

  if (options.queueType === 'transaction') {
    const reputation = await getTenantReputation(pool, tenantId);
    const queueDepth = await getInfraQueueDepth();
    const infraMult = await resolveInfraMultiplier(queueDepth);
    const resolved = resolveThroughputFromInputs({
      policy,
      reputationScore: reputation.score,
      queueDepth,
      queueType: 'transaction',
      infraMultiplier: infraMult,
    });
    return {
      hourly: resolved.effectiveHourly,
      burst: resolved.effectiveBurst,
    };
  }

  const row = await getTenantThroughputRow(pool, tenantId);
  if (!row) {
    return null;
  }
  return {
    hourly: row.effective_hourly_rate > 0 ? row.effective_hourly_rate : row.max_hourly_rate,
    burst: row.effective_burst_rate > 0 ? row.effective_burst_rate : row.max_burst_rate,
  };
}
