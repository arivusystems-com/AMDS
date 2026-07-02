import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { campaignBatchSchema, campaignEstimateQuerySchema, campaignHealthQuerySchema, loadConfig, estimateCompletionSeconds, formatDuration } from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { recordMessageEvent } from '../lib/events.js';
import { getCampaignQueue } from '../lib/campaign-queue.js';
import { isSuppressed, getVerifiedDomain } from '../lib/suppressions.js';
import { createTrackingTokens } from '../lib/tracking.js';
import { validateSendPolicy, acceptSendMessage } from '../lib/send-policy.js';
import { refreshTenantThroughput, getTenantThroughputRow, formatThroughputResponse } from '../lib/throughput-engine.js';
import { getCampaignHealth, formatCampaignHealthResponse } from '../lib/campaign-health.js';

function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

async function upsertCampaign(
  pool: ReturnType<typeof getPool>,
  tenantId: string,
  externalId: string
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO campaigns (tenant_id, external_id)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, external_id)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [tenantId, externalId]
  );
  return result.rows[0].id as string;
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>(
    '/v1/campaigns/:id/messages',
    async (request, reply) => {
      const parsed = campaignBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const body = parsed.data;
      const campaignExternalId = request.params.id;
      const config = loadConfig();
      const pool = getPool();

      const batchCheck = await validateSendPolicy(pool, body.tenant_id, {
        batchSize: body.messages.length,
        incrementBy: body.messages.length,
        queue: 'campaign',
      });
      if (!batchCheck.allowed) {
        return reply
          .code(batchCheck.httpStatus ?? 403)
          .header('Retry-After', String(batchCheck.retryAfterSec ?? 60))
          .send(batchCheck.body);
      }

      const fromDomain = extractDomain(body.from.email);
      if (config.ENFORCE_DOMAIN_VERIFICATION) {
        const pool = getPool();
        const verified = await getVerifiedDomain(pool, body.tenant_id, fromDomain);
        if (!verified) {
          return reply.code(403).send({
            error: 'Sending domain not verified',
            domain: fromDomain,
          });
        }
      }

      const trackingOpens = body.tracking?.opens ?? false;
      const trackingClicks = body.tracking?.clicks ?? false;
      const campaignId = await upsertCampaign(pool, body.tenant_id, campaignExternalId);
      const queue = getCampaignQueue();

      const accepted: Array<{ message_id: string; status: string; idempotency_key: string }> =
        [];
      const rejected: Array<{ idempotency_key: string; reason: string; detail?: unknown }> = [];

      for (const item of body.messages) {
        if (await isSuppressed(pool, body.tenant_id, item.to[0].email)) {
          rejected.push({
            idempotency_key: item.idempotency_key,
            reason: 'suppressed',
            detail: { email: item.to[0].email },
          });
          continue;
        }

        const existing = await pool.query(
          `SELECT id, status, created_at FROM messages
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [body.tenant_id, item.idempotency_key]
        );

        if (existing.rows.length > 0) {
          accepted.push({
            message_id: existing.rows[0].id,
            status: existing.rows[0].status,
            idempotency_key: item.idempotency_key,
          });
          continue;
        }

        const messageId = randomUUID();
        const metadata = {
          ...(body.metadata ?? {}),
          ...(item.metadata ?? {}),
          campaign_external_id: campaignExternalId,
        };

        const insert = await pool.query(
          `INSERT INTO messages (
            id, tenant_id, idempotency_key, status, queue,
            from_email, from_name, to_addresses, subject,
            content_html, content_text, metadata, tags,
            campaign_id, tracking_opens, tracking_clicks
          ) VALUES ($1,$2,$3,'queued','campaign',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          RETURNING id, created_at`,
          [
            messageId,
            body.tenant_id,
            item.idempotency_key,
            body.from.email,
            body.from.name ?? null,
            JSON.stringify(item.to),
            item.subject,
            item.content.html ?? null,
            item.content.text ?? null,
            JSON.stringify(metadata),
            item.tags ?? null,
            campaignId,
            trackingOpens,
            trackingClicks,
          ]
        );

        const row = insert.rows[0];

        const acceptCheck = await acceptSendMessage(
          pool,
          body.tenant_id,
          messageId,
          batchCheck.policyRequired ?? false,
          batchCheck.policy,
          { queue: 'campaign' }
        );
        if (!acceptCheck.allowed) {
          await pool.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
          rejected.push({
            idempotency_key: item.idempotency_key,
            reason: acceptCheck.reason ?? 'policy_violation',
            detail: acceptCheck.body,
          });
          continue;
        }

        if (trackingOpens || trackingClicks) {
          await createTrackingTokens(pool, {
            tenantId: body.tenant_id,
            messageId: row.id,
            html: item.content.html,
            opens: trackingOpens,
            clicks: trackingClicks,
          });
        }

        await recordMessageEvent(pool, row.id, 'queued', {
          queue: 'campaign',
          tenant_id: body.tenant_id,
          campaign_id: campaignExternalId,
        });

        await queue.add(
          'send',
          {
            messageId: row.id,
            tenantId: body.tenant_id,
            from: body.from,
            to: item.to,
            subject: item.subject,
            html: item.content.html,
            text: item.content.text,
            metadata,
            trackingOpens,
            trackingClicks,
          },
          { jobId: row.id }
        );

        accepted.push({
          message_id: row.id,
          status: 'queued',
          idempotency_key: item.idempotency_key,
        });
      }

      await pool.query(
        `UPDATE campaigns
         SET message_count = message_count + $2, updated_at = NOW()
         WHERE id = $1`,
        [campaignId, accepted.filter((a) => a.status === 'queued').length]
      );

      return reply.code(202).send({
        campaign_id: campaignExternalId,
        campaign_uuid: campaignId,
        accepted: accepted.length,
        rejected: rejected.length,
        messages: accepted,
        errors: rejected,
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/v1/campaigns/:id/estimate',
    async (request, reply) => {
      const parsed = campaignEstimateQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      await refreshTenantThroughput(pool, parsed.data.tenant_id, {
        notify: false,
        queueType: 'campaign',
      });
      const throughput = await getTenantThroughputRow(pool, parsed.data.tenant_id);
      if (!throughput) {
        return reply.code(404).send({ error: 'Tenant policy not found' });
      }

      const seconds = estimateCompletionSeconds(
        parsed.data.recipient_count,
        throughput.effective_hourly_rate
      );

      return reply.send({
        campaign_id: request.params.id,
        tenant_id: parsed.data.tenant_id,
        recipient_count: parsed.data.recipient_count,
        throughput: formatThroughputResponse(throughput),
        estimated_seconds: seconds,
        estimated_completion: seconds === null ? null : formatDuration(seconds),
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/v1/campaigns/:id/health',
    async (request, reply) => {
      const parsed = campaignHealthQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const health = await getCampaignHealth(
        pool,
        parsed.data.tenant_id,
        request.params.id
      );

      if (!health) {
        return reply.code(404).send({ error: 'Campaign not found' });
      }

      return reply.send(formatCampaignHealthResponse(health));
    }
  );
}
