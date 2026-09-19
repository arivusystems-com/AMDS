import { getRedis } from './redis.js';
import { getPool } from './db.js';
import { providerKeyForRecipient, computeLayeredHourlyRate } from '@vmds/shared';

function utcHourKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`;
}

async function getProviderLimit(providerKey: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT hourly_send_limit FROM provider_rate_limits WHERE provider_key = $1`,
    [providerKey]
  );
  return Number(result.rows[0]?.hourly_send_limit ?? 0);
}

export async function resolveLayeredHourlyRate(input: {
  tenantEffectiveHourly: number;
  poolHourlyLimit: number;
  recipientEmail: string;
}): Promise<{ hourly: number; provider: string; providerLimit: number }> {
  const provider = providerKeyForRecipient(input.recipientEmail);
  const providerLimit = await getProviderLimit(provider);
  const hourly = computeLayeredHourlyRate({
    tenantEffectiveHourly: input.tenantEffectiveHourly,
    poolHourlyLimit: input.poolHourlyLimit,
    ipHourlyLimit: 0,
    providerHourlyLimit: providerLimit,
    domainHourlyLimit: 0,
  });
  return { hourly, provider, providerLimit };
}

export async function acquireProviderSlot(
  providerKey: string,
  hourlyLimit: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (hourlyLimit <= 0) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const redis = getRedis();
  const key = `provider:${providerKey}:hourly:${utcHourKey()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3700);
  }
  if (count > hourlyLimit) {
    return { allowed: false, retryAfterMs: 60_000 };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export async function acquirePoolSlot(
  poolId: string,
  hourlyLimit: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (hourlyLimit <= 0) {
    return { allowed: true, retryAfterMs: 0 };
  }
  const redis = getRedis();
  const key = `pool:${poolId}:hourly:${utcHourKey()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3700);
  }
  if (count > hourlyLimit) {
    return { allowed: false, retryAfterMs: 60_000 };
  }
  return { allowed: true, retryAfterMs: 0 };
}
