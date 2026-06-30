import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@vmds/shared';
import { checkPostgres, checkRedis } from '../lib/auth.js';
import { getPool } from '../lib/db.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'amds-gateway',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const config = loadConfig();
    const pool = getPool();
    const [postgres, redis] = await Promise.all([
      checkPostgres(pool),
      checkRedis(config.REDIS_URL),
    ]);

    const ready = postgres && redis;
    const body = {
      status: ready ? 'ready' : 'not_ready',
      checks: { postgres, redis },
      timestamp: new Date().toISOString(),
    };

    reply.code(ready ? 200 : 503).send(body);
  });
}
