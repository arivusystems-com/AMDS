import type { FastifyInstance } from 'fastify';
import { reputationHistoryQuerySchema } from '@vmds/shared';
import { getPool } from '../lib/db.js';
import {
  formatReputationResponse,
  getReputationHistory,
  getTenantReputation,
  getReputationRecoveryInfo,
} from '../lib/reputation-engine.js';
import { getReputationGuidance } from '../lib/reputation-guidance.js';

export async function reputationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/reputation',
    async (request, reply) => {
      const pool = getPool();
      const row = await getTenantReputation(pool, request.params.tenantId);
      const recovery = await getReputationRecoveryInfo(pool, request.params.tenantId, row.score);
      return reply.send({ ...formatReputationResponse(row), recovery });
    }
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/reputation/history',
    async (request, reply) => {
      const parsed = reputationHistoryQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const history = await getReputationHistory(
        pool,
        request.params.tenantId,
        parsed.data.limit
      );

      return reply.send({
        tenant_id: request.params.tenantId,
        history: history.map((row) => ({
          id: row.id,
          score: Number(row.score),
          previous_score: Number(row.previous_score),
          delta: Number(row.delta),
          breakdown: row.breakdown,
          factors: row.factors,
          trigger_signal: row.trigger_signal,
          trigger_message_id: row.trigger_message_id,
          created_at: row.created_at,
        })),
      });
    }
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/reputation/guidance',
    async (request, reply) => {
      const pool = getPool();
      const guidance = await getReputationGuidance(pool, request.params.tenantId);
      return reply.send(guidance);
    }
  );
}
