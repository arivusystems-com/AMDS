import { Redis } from 'ioredis';
import { loadConfig } from '@vmds/shared';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    const config = loadConfig();
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis) {
    return;
  }
  const client = redis;
  redis = null;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
