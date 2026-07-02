import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@vmds/shared';
import { metricsContentType, metricsPayload } from '../lib/metrics.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    const config = loadConfig();
    if (!config.METRICS_ENABLED) {
      return reply.code(404).send({ error: 'Metrics disabled' });
    }

    const body = await metricsPayload();
    return reply.header('Content-Type', metricsContentType()).send(body);
  });
}
