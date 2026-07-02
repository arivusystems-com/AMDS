import { getRedis } from './redis.js';

function utcHourKey(): string {
  const now = new Date();
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `${day}${String(now.getUTCHours()).padStart(2, '0')}`;
}

/** Worker-side pacing against effective hourly rate (separate counter from gateway accept). */
export async function acquireDeliverySlot(
  tenantId: string,
  effectiveHourlyRate: number
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  if (effectiveHourlyRate <= 0) {
    return { allowed: true, retryAfterMs: 0 };
  }

  const redis = getRedis();
  const key = `throughput:delivery:${tenantId}:${utcHourKey()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 7200);
  }

  if (count <= effectiveHourlyRate) {
    return { allowed: true, retryAfterMs: 0 };
  }

  await redis.decr(key);
  const now = new Date();
  const msToNextHour =
    (60 - now.getUTCMinutes()) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  return { allowed: false, retryAfterMs: Math.max(1000, Math.min(msToNextHour, 3600_000)) };
}
