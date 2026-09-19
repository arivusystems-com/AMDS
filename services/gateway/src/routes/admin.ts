import type { FastifyInstance } from 'fastify';
import {
  loadConfig,
  simulateBounceSchema,
  parseDsn,
  adminReputationOverrideSchema,
  simulateComplaintSchema,
  simulateInfraPressureSchema,
  recordNegativeSignalSchema,
  assignDedicatedIpSchema,
  registerInventoryIpSchema,
  riskTierFromScore,
  resolvePoolId,
} from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { processBounce } from '../lib/bounce-handler.js';
import { processComplaint } from '../lib/complaint-handler.js';
import {
  adminOverrideReputation,
  formatReputationResponse,
  applyNegativeReputationSignal,
  getTenantReputation,
} from '../lib/reputation-engine.js';
import {
  setSimulatedInfraPressure,
  clearSimulatedInfraPressure,
  getInfraPressureSnapshot,
} from '../lib/infra-state.js';
import { getEgressIpStatus } from '../lib/egress-ip.js';
import { getIpPoolRows, formatIpPoolResponse } from '../lib/ip-pools.js';
import {
  listInventory,
  upsertInventoryIp,
  listTenantAssignments,
  assignDedicatedIp,
  releaseDedicatedIp,
} from '../lib/ip-inventory.js';
import { getQueue } from '../lib/queue.js';
import { getCampaignQueue } from '../lib/campaign-queue.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/admin/simulate-bounce', async (request, reply) => {
    const config = loadConfig();
    if (config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }

    const parsed = simulateBounceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { tenant_id, message_id, bounce_type, dsn } = parsed.data;
    const pool = getPool();

    const msg = await pool.query(
      `SELECT id, tenant_id, to_addresses, metadata FROM messages WHERE id = $1 AND tenant_id = $2`,
      [message_id, tenant_id]
    );

    if (msg.rows.length === 0) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    const row = msg.rows[0];
    const recipients = row.to_addresses as Array<{ email: string }>;
    const recipient =
      parsed.data.recipient ?? recipients[0]?.email ?? 'unknown@example.com';

    const defaultDsn =
      bounce_type === 'hard'
        ? `Final-Recipient: rfc822; ${recipient}\nDiagnostic-Code: smtp; 550 5.1.1 User unknown`
        : `Final-Recipient: rfc822; ${recipient}\nDiagnostic-Code: smtp; 451 4.2.1 Mailbox full`;

    const parsedBounce = parseDsn(dsn ?? defaultDsn);
    const classification =
      bounce_type === 'hard' ? 'hard' : bounce_type === 'soft' ? 'soft' : parsedBounce.classification;

    const result = await processBounce(pool, {
      tenantId: tenant_id,
      messageId: message_id,
      recipient,
      classification: classification === 'soft' ? 'soft' : 'hard',
      diagnostic: parsedBounce.diagnostic,
      statusCode: parsedBounce.statusCode,
      metadata: row.metadata as Record<string, unknown> | undefined,
    });

    return reply.send(result);
  });

  app.post('/v1/admin/simulate-complaint', async (request, reply) => {
    const config = loadConfig();
    if (config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }

    const parsed = simulateComplaintSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { tenant_id, message_id } = parsed.data;
    const pool = getPool();

    const msg = await pool.query(
      `SELECT id, tenant_id, to_addresses, metadata FROM messages WHERE id = $1 AND tenant_id = $2`,
      [message_id, tenant_id]
    );

    if (msg.rows.length === 0) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    const row = msg.rows[0];
    const recipients = row.to_addresses as Array<{ email: string }>;
    const recipient =
      parsed.data.recipient ?? recipients[0]?.email ?? 'unknown@example.com';

    const result = await processComplaint(pool, {
      tenantId: tenant_id,
      messageId: message_id,
      recipient,
      metadata: row.metadata as Record<string, unknown> | undefined,
    });

    return reply.send(result);
  });

  app.post<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/reputation',
    async (request, reply) => {
      const parsed = adminReputationOverrideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const row = await adminOverrideReputation(
        pool,
        request.params.tenantId,
        parsed.data.score,
        parsed.data.reason
      );

      return reply.send(formatReputationResponse(row));
    }
  );

  app.get('/v1/admin/ip-pools', async (_request, reply) => {
    const pool = getPool();
    const rows = await getIpPoolRows(pool);
    return reply.send({ pools: rows.map(formatIpPoolResponse) });
  });

  app.get('/v1/admin/ip-inventory', async (_request, reply) => {
    const pool = getPool();
    const rows = await listInventory(pool);
    return reply.send({
      inventory: rows.map((row) => ({
        ...row,
        updated_at: row.updated_at.toISOString(),
      })),
    });
  });

  app.post('/v1/admin/ip-inventory', async (request, reply) => {
    const parsed = registerInventoryIpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }
    const pool = getPool();
    const row = await upsertInventoryIp(pool, parsed.data);
    return reply.code(201).send({
      ...row,
      updated_at: row.updated_at.toISOString(),
    });
  });

  app.get('/v1/admin/egress-assignments', async (request, reply) => {
    const tenantId =
      typeof request.query === 'object' && request.query && 'tenant_id' in request.query
        ? String((request.query as { tenant_id?: string }).tenant_id ?? '')
        : '';
    const pool = getPool();
    const rows = await listTenantAssignments(pool, tenantId || undefined);
    return reply.send({ assignments: rows });
  });

  app.post<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/egress',
    async (request, reply) => {
      const parsed = assignDedicatedIpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }
      const pool = getPool();
      try {
        const assignment = await assignDedicatedIp(
          pool,
          request.params.tenantId,
          parsed.data.purpose,
          parsed.data.egress_ip
        );
        return reply.code(201).send(assignment);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Assign failed';
        return reply.code(409).send({ error: message });
      }
    }
  );

  app.delete<{ Params: { tenantId: string; purpose: string } }>(
    '/v1/admin/tenants/:tenantId/egress/:purpose',
    async (request, reply) => {
      const purpose = request.params.purpose;
      if (purpose !== 'transaction' && purpose !== 'marketing') {
        return reply.code(400).send({ error: 'purpose must be transaction or marketing' });
      }
      const pool = getPool();
      const result = await releaseDedicatedIp(pool, request.params.tenantId, purpose);
      return reply.send(result);
    }
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/routing',
    async (request, reply) => {
      const pool = getPool();
      const config = loadConfig();
      let score = config.REPUTATION_DEFAULT_SCORE;
      try {
        const rep = await getTenantReputation(pool, request.params.tenantId);
        score = rep.score;
      } catch {
        // default
      }
      const tier = riskTierFromScore(score);
      const policy = await pool.query(
        `SELECT ip_pool FROM tenant_policies WHERE tenant_id = $1`,
        [request.params.tenantId]
      );
      const override = (policy.rows[0]?.ip_pool as string | null) ?? null;
      const txPool = resolvePoolId('transaction', override, score);
      const mktPool = resolvePoolId('campaign', override, score);
      const assignments = await listTenantAssignments(pool, request.params.tenantId);

      return reply.send({
        tenant_id: request.params.tenantId,
        reputation_score: score,
        risk_tier: tier,
        policy_ip_pool: override,
        resolved: {
          transaction_pool: txPool,
          marketing_pool: mktPool,
        },
        dedicated: assignments,
      });
    }
  );

  app.post('/v1/admin/infra/simulate-pressure', async (request, reply) => {
    const config = loadConfig();
    if (config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }

    const parsed = simulateInfraPressureSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    await setSimulatedInfraPressure(parsed.data);
    return reply.send({ ok: true, simulated: parsed.data });
  });

  app.delete('/v1/admin/infra/simulate-pressure', async (request, reply) => {
    const config = loadConfig();
    if (config.NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }

    await clearSimulatedInfraPressure();
    return reply.send({ ok: true });
  });

  app.get('/v1/admin/infra/status', async (_request, reply) => {
    const config = loadConfig();
    const pool = getPool();

    let queueDepth = 0;
    try {
      const [tx, campaign] = await Promise.all([
        getQueue().getJobCounts('waiting', 'active', 'delayed'),
        getCampaignQueue().getJobCounts('waiting', 'active', 'delayed'),
      ]);
      queueDepth =
        (tx.waiting ?? 0) +
        (tx.active ?? 0) +
        (tx.delayed ?? 0) +
        (campaign.waiting ?? 0) +
        (campaign.active ?? 0) +
        (campaign.delayed ?? 0);
    } catch {
      queueDepth = 0;
    }

    const pressure = await getInfraPressureSnapshot(queueDepth);
    const egress = await getEgressIpStatus(pool, config.EGRESS_IP);
    const pools = await getIpPoolRows(pool);
    const inventory = await listInventory(pool);

    return reply.send({
      infra: pressure,
      egress,
      pools: pools.map(formatIpPoolResponse),
      inventory_summary: {
        total: inventory.length,
        free: inventory.filter((i) => i.state === 'free').length,
        assigned: inventory.filter((i) => i.state === 'assigned').length,
        shared: inventory.filter((i) => i.state === 'shared').length,
        quarantine: inventory.filter((i) => i.state === 'quarantine').length,
      },
    });
  });

  app.post<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/reputation/signal',
    async (request, reply) => {
      const parsed = recordNegativeSignalSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const row = await applyNegativeReputationSignal(pool, {
        tenantId: request.params.tenantId,
        signalType: parsed.data.signal_type,
        messageId: parsed.data.message_id,
        detail: { reason: parsed.data.reason },
      });

      return reply.send(formatReputationResponse(row));
    }
  );
}
