import type { FastifyInstance } from 'fastify';
import {
  tenantPolicySchema,
  creditAllocationSchema,
  loadConfig,
} from '@vmds/shared';
import { getPool } from '../lib/db.js';
import {
  allocateCredits,
  formatPolicyResponse,
  getTenantPolicy,
  setTenantStatus,
  upsertTenantPolicy,
} from '../lib/tenant-policies.js';
import { ensureTenantReputation } from '../lib/reputation-engine.js';
import { refreshTenantThroughput } from '../lib/throughput-engine.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/policy',
    async (request, reply) => {
      const parsed = tenantPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const row = await upsertTenantPolicy(pool, request.params.tenantId, parsed.data);
      if (parsed.data.reputation_enabled) {
        await ensureTenantReputation(pool, request.params.tenantId);
      }
      await refreshTenantThroughput(pool, request.params.tenantId, { notify: false });
      return reply.send(formatPolicyResponse(row));
    }
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/policy',
    async (request, reply) => {
      const pool = getPool();
      const row = await getTenantPolicy(pool, request.params.tenantId);
      if (!row) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }
      return reply.send(formatPolicyResponse(row));
    }
  );

  app.patch<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/credits',
    async (request, reply) => {
      const parsed = creditAllocationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const row = await allocateCredits(
        pool,
        request.params.tenantId,
        parsed.data.amount,
        parsed.data.reason
      );
      if (!row) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }
      return reply.send(formatPolicyResponse(row));
    }
  );

  app.post<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/suspend',
    async (request, reply) => {
      const pool = getPool();
      const row = await setTenantStatus(pool, request.params.tenantId, 'suspended');
      if (!row) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }
      return reply.send(formatPolicyResponse(row));
    }
  );

  app.post<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/activate',
    async (request, reply) => {
      const pool = getPool();
      const row = await setTenantStatus(pool, request.params.tenantId, 'active');
      if (!row) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }
      return reply.send(formatPolicyResponse(row));
    }
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/tenants/:tenantId/credits/ledger',
    async (request, reply) => {
      const config = loadConfig();
      if (config.NODE_ENV === 'production') {
        return reply.code(404).send({ error: 'Not found' });
      }

      const pool = getPool();
      const limit = Math.min(Number(request.query && (request.query as { limit?: string }).limit) || 50, 200);
      const result = await pool.query(
        `SELECT id, tenant_id, message_id, action, amount, balance_after, reserved_after, detail, created_at
         FROM credit_ledger
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [request.params.tenantId, limit]
      );
      return reply.send({ entries: result.rows });
    }
  );
}
