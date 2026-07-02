import { getRedis } from './redis.js';
import { loadConfig } from '@vmds/shared';

export async function checkRateLimit(tenantId: string): Promise<{ allowed: boolean; remaining: number }> {
  const config = loadConfig();
  const redis = getRedis();
  const windowKey = Math.floor(Date.now() / (config.RATE_LIMIT_WINDOW_SEC * 1000));
  const key = `ratelimit:${tenantId}:${windowKey}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, config.RATE_LIMIT_WINDOW_SEC);
  }

  const remaining = Math.max(0, config.RATE_LIMIT_MAX - count);
  return {
    allowed: count <= config.RATE_LIMIT_MAX,
    remaining,
  };
}
