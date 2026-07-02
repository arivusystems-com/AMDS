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

function closeTimeoutMs(): number {
  return 2_000;
}

export async function closeRedis(): Promise<void> {
  if (!redis) {
    return;
  }

  const client = redis;
  redis = null;

  try {
    if (client.status === 'ready' || client.status === 'connect') {
      await Promise.race([
        client.quit(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('redis quit timed out')), closeTimeoutMs());
        }),
      ]);
      return;
    }
  } catch {
    // Fall through to hard disconnect when quit hangs or Redis is unreachable.
  }

  client.disconnect();
}
