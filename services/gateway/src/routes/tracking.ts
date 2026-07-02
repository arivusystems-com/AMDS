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
}
