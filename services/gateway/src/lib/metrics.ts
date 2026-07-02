import client from 'prom-client';
import {
  loadConfig,
  QUEUE_NAME,
  CAMPAIGN_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
} from '@vmds/shared';
import { getPool } from './db.js';
import { getQueue } from './queue.js';
import { getCampaignQueue } from './campaign-queue.js';
import { getWebhookQueue } from './webhook-dispatch.js';
import { getInfraPressureSnapshot } from './infra-state.js';

const register = new client.Registry();

client.collectDefaultMetrics({ register, prefix: 'amds_' });

export const httpRequestsTotal = new client.Counter({
  name: 'amds_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'amds_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const queueJobs = new client.Gauge({
  name: 'amds_queue_jobs',
  help: 'BullMQ job counts by queue and state',
  labelNames: ['queue', 'state'] as const,
  registers: [register],
});

export const messagesByStatus = new client.Gauge({
  name: 'amds_messages_by_status',
  help: 'Message count by delivery status',
  labelNames: ['status'] as const,
  registers: [register],
});

export const webhookOutboxPending = new client.Gauge({
  name: 'amds_webhook_outbox_pending',
  help: 'Webhook outbox rows awaiting delivery',
  registers: [register],
});

export const infraMultiplierGauge = new client.Gauge({
  name: 'amds_infra_multiplier',
  help: 'Platform infrastructure throughput multiplier',
  registers: [register],
});

export const tenantReputationScore = new client.Gauge({
  name: 'amds_tenant_reputation_score',
  help: 'Tenant sender reputation score',
  labelNames: ['tenant_id'] as const,
  registers: [register],
});

export const tenantEffectiveHourlyRate = new client.Gauge({
  name: 'amds_tenant_effective_hourly_rate',
  help: 'Tenant effective hourly send rate',
  labelNames: ['tenant_id'] as const,
  registers: [register],
});

export function routeLabel(url: string): string {
  const pathname = url.split('?')[0] ?? url;
  if (pathname.startsWith('/v1/messages/')) return '/v1/messages/:id';
  if (pathname.startsWith('/v1/domains/')) return '/v1/domains/:domain';
  if (pathname.startsWith('/v1/campaigns/')) return '/v1/campaigns/:id/messages';
  if (pathname.startsWith('/v1/suppressions/')) return '/v1/suppressions/:email';
  if (pathname.startsWith('/t/')) return '/t/:token.png';
  if (pathname.startsWith('/c/')) return '/c/:token';
  return pathname;
}

export async function refreshOperationalMetrics(): Promise<void> {
  const queues = [
    { name: QUEUE_NAME, queue: getQueue() },
    { name: CAMPAIGN_QUEUE_NAME, queue: getCampaignQueue() },
    { name: WEBHOOK_QUEUE_NAME, queue: getWebhookQueue() },
  ];

  for (const { name, queue } of queues) {
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed'
    );
    for (const [state, count] of Object.entries(counts)) {
      queueJobs.set({ queue: name, state }, count);
    }
  }

  const pool = getPool();
  const statusResult = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM messages GROUP BY status`
  );
  messagesByStatus.reset();
  for (const row of statusResult.rows) {
    messagesByStatus.set({ status: row.status }, row.count);
  }

  const outboxResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM webhook_outbox WHERE status = 'pending'`
  );
  webhookOutboxPending.set(outboxResult.rows[0]?.count ?? 0);

  let queueDepth = 0;
  for (const { name, queue } of queues) {
    if (name === WEBHOOK_QUEUE_NAME) {
      continue;
    }
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    queueDepth += (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }
  const pressure = await getInfraPressureSnapshot(queueDepth);
  infraMultiplierGauge.set(pressure.multiplier);

  tenantReputationScore.reset();
  tenantEffectiveHourlyRate.reset();
  const throughputResult = await pool.query(
    `SELECT tt.tenant_id, tt.effective_hourly_rate, tr.score
     FROM tenant_throughput tt
     LEFT JOIN tenant_reputation tr ON tr.tenant_id = tt.tenant_id`
  );
  for (const row of throughputResult.rows) {
    tenantEffectiveHourlyRate.set(
      { tenant_id: row.tenant_id },
      Number(row.effective_hourly_rate)
    );
    if (row.score !== null && row.score !== undefined) {
      tenantReputationScore.set({ tenant_id: row.tenant_id }, Number(row.score));
    }
  }
}

export async function metricsPayload(): Promise<string> {
  if (loadConfig().METRICS_ENABLED) {
    await refreshOperationalMetrics();
  }
  return register.metrics();
}

export function metricsContentType(): string {
  return register.contentType;
}
