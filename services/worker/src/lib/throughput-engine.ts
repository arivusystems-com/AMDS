import type { Pool } from 'pg';
import {
  loadConfig,
  reputationMultiplier,
  warmupMultiplier,
  computeEffectiveRate,
} from '@vmds/shared';
import { resolveInfraMultiplier } from './infra-state.js';

export async function getTenantPolicyForThroughput(
  pool: Pool,
  tenantId: string
): Promise<{
  max_hourly_rate: number;
  burst_rate_per_min: number;
  warmup_enabled: boolean;
  first_send_at: Date | null;
} | null> {
  const result = await pool.query(
    `SELECT max_hourly_rate, burst_rate_per_min, warmup_enabled, first_send_at
     FROM tenant_policies WHERE tenant_id = $1`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    max_hourly_rate: Number(row.max_hourly_rate),
    burst_rate_per_min: Number(row.burst_rate_per_min),
    warmup_enabled: Boolean(row.warmup_enabled),
    first_send_at: row.first_send_at ? new Date(row.first_send_at) : null,
  };
}

export async function getReputationScore(pool: Pool, tenantId: string): Promise<number> {
  const config = loadConfig();
  const result = await pool.query(`SELECT score FROM tenant_reputation WHERE tenant_id = $1`, [
    tenantId,
  ]);
  if (result.rows.length === 0) {
    return config.REPUTATION_DEFAULT_SCORE;
  }
  return Number(result.rows[0].score);
}

export async function getEffectiveHourlyRate(
  pool: Pool,
  tenantId: string,
  queueType: 'transaction' | 'campaign'
): Promise<number> {
  const cached = await pool.query(
    `SELECT effective_hourly_rate, max_hourly_rate FROM tenant_throughput WHERE tenant_id = $1`,
    [tenantId]
  );
  if (cached.rows.length > 0) {
    const effective = Number(cached.rows[0].effective_hourly_rate);
    if (effective > 0) {
      return effective;
    }
    return Number(cached.rows[0].max_hourly_rate);
  }

  const policy = await getTenantPolicyForThroughput(pool, tenantId);
  if (!policy) {
    return 0;
  }

  const config = loadConfig();
  const score = await getReputationScore(pool, tenantId);
  const rep = reputationMultiplier(score);
  const warm = warmupMultiplier({
    firstSendAt: policy.first_send_at,
    warmupEnabled: policy.warmup_enabled,
    reputationScore: score,
    disableReputationScore: config.WARMUP_DISABLE_REPUTATION_SCORE,
    disableMinDays: config.WARMUP_DISABLE_MIN_DAYS,
  });
  const infra = await resolveInfraMultiplier(0);
  const floor = queueType === 'transaction' ? config.TRANSACTION_THROUGHPUT_FLOOR : 0;

  return computeEffectiveRate(
    policy.max_hourly_rate,
    { reputation: rep, warmup: warm.multiplier, infra },
    floor
  );
}

export async function refreshTenantThroughputCache(
  pool: Pool,
  tenantId: string,
  queueType: 'transaction' | 'campaign' = 'transaction'
): Promise<void> {
  const policy = await getTenantPolicyForThroughput(pool, tenantId);
  if (!policy) {
    return;
  }

  const config = loadConfig();
  const score = await getReputationScore(pool, tenantId);
  const rep = reputationMultiplier(score);
  const warm = warmupMultiplier({
    firstSendAt: policy.first_send_at,
    warmupEnabled: policy.warmup_enabled,
    reputationScore: score,
    disableReputationScore: config.WARMUP_DISABLE_REPUTATION_SCORE,
    disableMinDays: config.WARMUP_DISABLE_MIN_DAYS,
  });
  const infra = await resolveInfraMultiplier(0);
  const floor = queueType === 'transaction' ? config.TRANSACTION_THROUGHPUT_FLOOR : 0;
  const effectiveHourly = computeEffectiveRate(
    policy.max_hourly_rate,
    { reputation: rep, warmup: warm.multiplier, infra },
    floor
  );
  const effectiveBurst =
    policy.burst_rate_per_min > 0
      ? Math.max(
          1,
          Math.floor(policy.burst_rate_per_min * Math.max(rep * warm.multiplier * infra, floor))
        )
      : 0;

  await pool.query(
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
       updated_at = NOW()`,
    [
      tenantId,
      policy.max_hourly_rate,
      policy.burst_rate_per_min,
      effectiveHourly,
      effectiveBurst,
      rep,
      warm.multiplier,
      infra,
      Math.max(rep * warm.multiplier * infra, floor),
      warm.stage,
      score,
    ]
  );
}
