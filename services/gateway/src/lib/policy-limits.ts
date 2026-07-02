import { getRedis } from './redis.js';
import { loadConfig } from '@vmds/shared';
import type { TenantPolicyRow } from './tenant-policies.js';
import type { SendPolicyViolationReason } from '@vmds/shared';

export interface PolicyLimitResult {
  allowed: boolean;
  reason?: SendPolicyViolationReason;
  remaining?: number;
  retryAfterSec?: number;
  limit?: number;
}

function utcDayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function utcHourKey(): string {
  const now = new Date();
  return `${utcDayKey()}${String(now.getUTCHours()).padStart(2, '0')}`;
}

function utcMinuteKey(): string {
  const now = new Date();
  return `${utcHourKey()}${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

async function readCounter(key: string): Promise<number> {
  const redis = getRedis();
  const value = await redis.get(key);
  return value ? Number.parseInt(value, 10) : 0;
}

async function incrementCounter(key: string, ttlSec: number): Promise<number> {
  const redis = getRedis();
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSec);
  }
  return count;
}

/** Fallback when no tenant policy exists — uses global env rate limit. */
export async function checkGlobalRateLimit(tenantId: string): Promise<PolicyLimitResult> {
  const config = loadConfig();
  const windowKey = Math.floor(Date.now() / (config.RATE_LIMIT_WINDOW_SEC * 1000));
  const key = `ratelimit:${tenantId}:${windowKey}`;
  const count = await incrementCounter(key, config.RATE_LIMIT_WINDOW_SEC);
  const remaining = Math.max(0, config.RATE_LIMIT_MAX - count);
  return {
    allowed: count <= config.RATE_LIMIT_MAX,
    reason: count > config.RATE_LIMIT_MAX ? 'burst_limit_exceeded' : undefined,
    remaining,
    retryAfterSec: config.RATE_LIMIT_WINDOW_SEC,
    limit: config.RATE_LIMIT_MAX,
  };
}

/** Read-only quota validation (no Redis writes). */
export async function validatePolicyQuotas(
  policy: TenantPolicyRow,
  options: {
    batchSize?: number;
    incrementBy?: number;
    effectiveHourly?: number;
    effectiveBurst?: number;
  }
): Promise<PolicyLimitResult> {
  const incrementBy = options.incrementBy ?? 1;
  const batchSize = options.batchSize ?? incrementBy;
  const hourlyLimit =
    options.effectiveHourly && options.effectiveHourly > 0
      ? options.effectiveHourly
      : policy.max_hourly_rate;
  const burstLimit =
    options.effectiveBurst && options.effectiveBurst > 0
      ? options.effectiveBurst
      : policy.burst_rate_per_min;

  if (policy.status === 'suspended') {
    return { allowed: false, reason: 'tenant_suspended' };
  }

  if (policy.credits_remaining < incrementBy) {
    return {
      allowed: false,
      reason: 'insufficient_credits',
      remaining: policy.credits_remaining,
    };
  }

  if (policy.max_campaign_size > 0 && batchSize > policy.max_campaign_size) {
    return {
      allowed: false,
      reason: 'campaign_size_exceeded',
      limit: policy.max_campaign_size,
    };
  }

  if (policy.daily_send_limit > 0) {
    const dailyKey = `policy:daily:${policy.tenant_id}:${utcDayKey()}`;
    const dailyCount = await readCounter(dailyKey);
    if (dailyCount + incrementBy > policy.daily_send_limit) {
      return {
        allowed: false,
        reason: 'daily_limit_exceeded',
        remaining: Math.max(0, policy.daily_send_limit - dailyCount),
        retryAfterSec: 3600,
        limit: policy.daily_send_limit,
      };
    }
  }

  if (burstLimit > 0) {
    const burstKey = `policy:burst:${policy.tenant_id}:${utcMinuteKey()}`;
    const burstCount = await readCounter(burstKey);
    if (burstCount + incrementBy > burstLimit) {
      return {
        allowed: false,
        reason: 'burst_limit_exceeded',
        remaining: Math.max(0, burstLimit - burstCount),
        retryAfterSec: 60,
        limit: burstLimit,
      };
    }
  }

  if (hourlyLimit > 0) {
    const hourlyKey = `policy:hourly:${policy.tenant_id}:${utcHourKey()}`;
    const hourlyCount = await readCounter(hourlyKey);
    if (hourlyCount + incrementBy > hourlyLimit) {
      return {
        allowed: false,
        reason: 'hourly_limit_exceeded',
        remaining: Math.max(0, hourlyLimit - hourlyCount),
        retryAfterSec: 3600,
        limit: hourlyLimit,
      };
    }
  }

  return { allowed: true, remaining: policy.credits_remaining };
}

/** Increment Redis counters after a message is accepted. */
export async function consumePolicyQuotas(
  policy: TenantPolicyRow,
  incrementBy = 1,
  effective?: { hourly?: number; burst?: number }
): Promise<void> {
  const redis = getRedis();
  const hourlyLimit =
    effective?.hourly && effective.hourly > 0 ? effective.hourly : policy.max_hourly_rate;
  const burstLimit =
    effective?.burst && effective.burst > 0 ? effective.burst : policy.burst_rate_per_min;

  if (policy.daily_send_limit > 0) {
    const key = `policy:daily:${policy.tenant_id}:${utcDayKey()}`;
    await redis.incrby(key, incrementBy);
    await redis.expire(key, 86_400);
  }
  if (burstLimit > 0) {
    const key = `policy:burst:${policy.tenant_id}:${utcMinuteKey()}`;
    await redis.incrby(key, incrementBy);
    await redis.expire(key, 120);
  }
  if (hourlyLimit > 0) {
    const key = `policy:hourly:${policy.tenant_id}:${utcHourKey()}`;
    await redis.incrby(key, incrementBy);
    await redis.expire(key, 7200);
  }
}

export async function rollbackPolicyCounters(
  policy: TenantPolicyRow,
  incrementBy = 1
): Promise<void> {
  const redis = getRedis();
  const keys: string[] = [];
  if (policy.daily_send_limit > 0) {
    keys.push(`policy:daily:${policy.tenant_id}:${utcDayKey()}`);
  }
  if (policy.burst_rate_per_min > 0) {
    keys.push(`policy:burst:${policy.tenant_id}:${utcMinuteKey()}`);
  }
  if (policy.max_hourly_rate > 0) {
    keys.push(`policy:hourly:${policy.tenant_id}:${utcHourKey()}`);
  }
  for (const key of keys) {
    const current = await redis.decrby(key, incrementBy);
    if (current <= 0) {
      await redis.del(key);
    }
  }
}
