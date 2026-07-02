import type { FastifyInstance } from 'fastify';
import { analyticsSummarySchema } from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { getAnalyticsSummary } from '../lib/analytics.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/analytics/summary', async (request, reply) => {
    const parsed = analyticsSummarySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const query = parsed.data;
    const pool = getPool();

    const summary = await getAnalyticsSummary(pool, {
      tenantId: query.tenant_id,
      campaignExternalId: query.campaign_id,
      from: query.from,
      to: query.to,
    });

    return reply.send(summary);
  });
}
