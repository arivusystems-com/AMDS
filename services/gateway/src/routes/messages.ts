import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  sendMessageSchema,
  loadConfig,
  type SendMessageResponse,
} from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { recordMessageEvent, getMessageEvents } from '../lib/events.js';
import { getQueue } from '../lib/queue.js';
import { isSuppressed, getVerifiedDomain } from '../lib/suppressions.js';
import { createTrackingTokens } from '../lib/tracking.js';
import { validateSendPolicy, acceptSendMessage } from '../lib/send-policy.js';

function extractDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/messages', async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const body = parsed.data;
    const config = loadConfig();
    const pool = getPool();

    const policyCheck = await validateSendPolicy(pool, body.tenant_id, {
      queue: 'transaction',
    });
    if (!policyCheck.allowed) {
      return reply
        .code(policyCheck.httpStatus ?? 403)
        .header('Retry-After', String(policyCheck.retryAfterSec ?? 60))
        .send(policyCheck.body);
    }

    const suppressedRecipients: string[] = [];
    for (const recipient of body.to) {
      if (await isSuppressed(pool, body.tenant_id, recipient.email)) {
        suppressedRecipients.push(recipient.email);
      }
    }

    if (suppressedRecipients.length > 0) {
      return reply.code(422).send({
        error: 'Recipient suppressed',
        suppressed: suppressedRecipients,
      });
    }

    const fromDomain = extractDomain(body.from.email);
    if (config.ENFORCE_DOMAIN_VERIFICATION) {
      const verified = await getVerifiedDomain(pool, body.tenant_id, fromDomain);
      if (!verified) {
        return reply.code(403).send({
          error: 'Sending domain not verified',
          domain: fromDomain,
        });
      }
    }

    const existing = await pool.query(
      `SELECT id, status, created_at FROM messages
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [body.tenant_id, body.idempotency_key]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const response: SendMessageResponse = {
        message_id: row.id,
        status: 'queued',
        queue: 'transaction',
        created_at: row.created_at.toISOString(),
      };
      return reply.code(200).send(response);
    }

    const messageId = randomUUID();
    const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
    const now = Date.now();
    const isScheduled = scheduledAt !== null && scheduledAt.getTime() > now + 1000;
    const initialStatus = isScheduled ? 'scheduled' : 'queued';
    const trackingOpens = body.tracking?.opens ?? false;
    const trackingClicks = body.tracking?.clicks ?? false;

    const insert = await pool.query(
      `INSERT INTO messages (
        id, tenant_id, idempotency_key, status, queue,
        from_email, from_name, to_addresses, subject,
        content_html, content_text, metadata, tags, scheduled_at,
        tracking_opens, tracking_clicks
      ) VALUES ($1,$2,$3,$4,'transaction',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id, created_at`,
      [
        messageId,
        body.tenant_id,
        body.idempotency_key,
        initialStatus,
        body.from.email,
        body.from.name ?? null,
        JSON.stringify(body.to),
        body.subject,
        body.content.html ?? null,
        body.content.text ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        body.tags ?? null,
        scheduledAt,
        trackingOpens,
        trackingClicks,
      ]
    );

    const acceptCheck = await acceptSendMessage(
      pool,
      body.tenant_id,
      messageId,
      policyCheck.policyRequired ?? false,
      policyCheck.policy,
      { queue: 'transaction' }
    );
    if (!acceptCheck.allowed) {
      await pool.query(`DELETE FROM messages WHERE id = $1`, [messageId]);
      return reply
        .code(acceptCheck.httpStatus ?? 402)
        .header('Retry-After', String(acceptCheck.retryAfterSec ?? 60))
        .send(acceptCheck.body);
    }

    const row = insert.rows[0];

    if (trackingOpens || trackingClicks) {
      await createTrackingTokens(pool, {
        tenantId: body.tenant_id,
        messageId: row.id,
        html: body.content.html,
        opens: trackingOpens,
        clicks: trackingClicks,
      });
    }
    await recordMessageEvent(pool, row.id, 'queued', {
      queue: 'transaction',
      tenant_id: body.tenant_id,
      scheduled: isScheduled,
      scheduled_at: scheduledAt?.toISOString() ?? null,
    });

    const queue = getQueue();
    const delayMs = isScheduled && scheduledAt ? scheduledAt.getTime() - now : 0;

    await queue.add(
      'send',
      {
        messageId: row.id,
        tenantId: body.tenant_id,
        from: body.from,
        to: body.to,
        subject: body.subject,
        html: body.content.html,
        text: body.content.text,
        metadata: body.metadata,
        trackingOpens,
        trackingClicks,
      },
      { jobId: row.id, delay: Math.max(0, delayMs) }
    );

    const response: SendMessageResponse = {
      message_id: row.id,
      status: 'queued',
      queue: 'transaction',
      created_at: row.created_at.toISOString(),
    };

    return reply.code(202).send(response);
  });

  app.get<{ Params: { id: string } }>('/v1/messages/:id', async (request, reply) => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, tenant_id, status, queue, subject, to_addresses,
              smtp_response, error_message, attempt_count,
              created_at, updated_at, delivered_at, scheduled_at, metadata
       FROM messages WHERE id = $1`,
      [request.params.id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    const row = result.rows[0];
    const events = await getMessageEvents(pool, row.id);

    const deadLetter = await pool.query(
      `SELECT failure_reason, attempt_count, moved_at
       FROM dead_letter_messages WHERE message_id = $1`,
      [row.id]
    );

    return reply.send({
      message_id: row.id,
      tenant_id: row.tenant_id,
      status: row.status,
      queue: row.queue,
      subject: row.subject,
      to: row.to_addresses,
      smtp_response: row.smtp_response,
      error_message: row.error_message,
      attempt_count: row.attempt_count,
      metadata: row.metadata,
      scheduled_at: row.scheduled_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      delivered_at: row.delivered_at,
      events,
      dead_letter: deadLetter.rows[0] ?? null,
    });
  });
}
