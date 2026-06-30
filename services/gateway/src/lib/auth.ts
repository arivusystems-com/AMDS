import type { Pool } from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { loadConfig } from '@vmds/shared';

export function createAuthHook() {
  const config = loadConfig();

  return async function authHook(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (request.url === '/health' || request.url === '/ready') {
      return;
    }

    const auth = request.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = auth.slice('Bearer '.length);
    if (token !== config.AMDS_API_KEY) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }
  };
}

export async function checkPostgres(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function checkRedis(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2000, lazyConnect: true });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}
