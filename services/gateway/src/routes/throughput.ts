import type { FastifyInstance } from 'fastify';
import { getPool } from '../lib/db.js';
import {
  formatThroughputResponse,
  getTenantThroughputRow,
  refreshTenantThroughput,
} from '../lib/throughput-engine.js';

export async function throughputRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/throughput',
    async (request, reply) => {
      const pool = getPool();
      await refreshTenantThroughput(pool, request.params.tenantId, { notify: false });
      const row = await getTenantThroughputRow(pool, request.params.tenantId);
      if (!row) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }
      return reply.send(formatThroughputResponse(row));
    }
  );
}
