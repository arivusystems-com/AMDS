import type { FastifyInstance } from 'fastify';
import { TRANSPARENT_PNG } from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { recordMessageEvent } from '../lib/events.js';
import { dispatchWebhook } from '../lib/webhook-dispatch.js';
import { recordTrackingHit } from '../lib/tracking.js';
import { recordReputationSignal } from '../lib/reputation-engine.js';

async function dispatchEngagementWebhook(
  hit: NonNullable<Awaited<ReturnType<typeof recordTrackingHit>>>,
  eventType: 'message.opened' | 'message.clicked'
): Promise<void> {
  if (!hit.isFirstHit) {
    return;
  }

  try {
    await dispatchWebhook({
      event_type: eventType,
      tenant_id: hit.tenantId,
      message_id: hit.messageId,
      metadata: hit.metadata ?? undefined,
      engagement: {
        recipient: hit.recipient ?? undefined,
        url: hit.targetUrl ?? undefined,
        hit_count: hit.hitCount,
      },
    });
  } catch {
    // Engagement state is persisted; webhook retry can be added in a future track
  }
}

export async function trackingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string } }>('/t/:token.png', async (request, reply) => {
    const token = request.params.token;
    const pool = getPool();

    const hit = await recordTrackingHit(pool, token);
    if (!hit || hit.tokenType !== 'open') {
      return reply.code(404).send({ error: 'Not found' });
    }

    await recordMessageEvent(pool, hit.messageId, 'opened', {
      hit_count: hit.hitCount,
      recipient: hit.recipient,
    });

    await dispatchEngagementWebhook(hit, 'message.opened');

    if (hit.isFirstHit) {
      void recordReputationSignal(pool, {
        tenantId: hit.tenantId,
        messageId: hit.messageId,
        signalType: 'open',
      });
    }

    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate')
      .send(TRANSPARENT_PNG);
  });

  app.get<{ Params: { token: string } }>('/c/:token', async (request, reply) => {
    const token = request.params.token;
    const pool = getPool();

    const hit = await recordTrackingHit(pool, token);
    if (!hit || hit.tokenType !== 'click' || !hit.targetUrl) {
      return reply.code(404).send({ error: 'Not found' });
    }

    await recordMessageEvent(pool, hit.messageId, 'clicked', {
      hit_count: hit.hitCount,
      url: hit.targetUrl,
      recipient: hit.recipient,
    });

    await dispatchEngagementWebhook(hit, 'message.clicked');

    if (hit.isFirstHit) {
      void recordReputationSignal(pool, {
        tenantId: hit.tenantId,
        messageId: hit.messageId,
        signalType: 'click',
      });
    }

    return reply.redirect(hit.targetUrl, 302);
  });

  async function handleUnsubscribe(
    messageId: string,
    reply: import('fastify').FastifyReply
  ) {
    const pool = getPool();
    const msg = await pool.query(
      `SELECT id, tenant_id, to_addresses, metadata FROM messages WHERE id = $1`,
      [messageId]
    );
    if (msg.rows.length === 0) {
      return reply.code(404).type('text/html').send('<h1>Not found</h1>');
    }

    const row = msg.rows[0];
    const recipients = row.to_addresses as Array<{ email: string }>;
    const recipient = recipients[0]?.email;
    if (!recipient) {
      return reply.code(400).type('text/html').send('<h1>No recipient</h1>');
    }

    await pool.query(
      `INSERT INTO suppressions (tenant_id, email, reason, source_message_id)
       VALUES ($1, $2, 'unsubscribe', $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         reason = EXCLUDED.reason,
         source_message_id = EXCLUDED.source_message_id`,
      [row.tenant_id, recipient.toLowerCase(), messageId]
    );

    await recordMessageEvent(pool, messageId, 'unsubscribed', { recipient });

    void recordReputationSignal(pool, {
      tenantId: row.tenant_id as string,
      messageId,
      signalType: 'unsubscribe',
      detail: { recipient },
    });

    try {
      await dispatchWebhook({
        event_type: 'message.unsubscribed',
        tenant_id: row.tenant_id as string,
        message_id: messageId,
        metadata: (row.metadata as Record<string, unknown>) ?? undefined,
        engagement: { recipient, hit_count: 1 },
      });
    } catch {
      // best-effort
    }

    return reply
      .type('text/html')
      .send(
        '<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>Unsubscribed</h1><p>You will no longer receive marketing email from this sender via AMDS.</p></body></html>'
      );
  }

  app.get<{ Params: { messageId: string } }>('/u/:messageId', async (request, reply) => {
    return handleUnsubscribe(request.params.messageId, reply);
  });

  app.post<{ Params: { messageId: string } }>('/u/:messageId', async (request, reply) => {
    return handleUnsubscribe(request.params.messageId, reply);
  });
}
