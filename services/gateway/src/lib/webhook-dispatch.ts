import { createHmac, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import {
  loadConfig,
  WEBHOOK_QUEUE_NAME,
  createLogger,
  type WebhookEvent,
  type WebhookJob,
} from '@vmds/shared';
import { getPool } from './db.js';
import { recordMessageEvent } from './events.js';

const log = createLogger('gateway');

let webhookQueue: Queue<WebhookJob> | null = null;

export function getWebhookQueue(): Queue<WebhookJob> {
  if (!webhookQueue) {
    const config = loadConfig();
    webhookQueue = new Queue<WebhookJob>(WEBHOOK_QUEUE_NAME, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 1000,
        attempts: config.WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.WEBHOOK_RETRY_DELAY_MS },
      },
    });
  }
  return webhookQueue;
}

async function postWebhook(payload: WebhookEvent): Promise<void> {
  const config = loadConfig();
  if (!config.LITEDESK_WEBHOOK_URL) {
    return;
  }

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', config.WEBHOOK_SIGNING_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const response = await fetch(config.LITEDESK_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AMDS-Signature': signature,
      'X-AMDS-Timestamp': timestamp,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
  }
}

export async function dispatchWebhook(
  event: Omit<WebhookEvent, 'event_id' | 'timestamp'>
): Promise<void> {
  const config = loadConfig();
  if (!config.LITEDESK_WEBHOOK_URL) {
    return;
  }

  const pool = getPool();
  const eventId = `evt_${randomUUID()}`;
  const payload: WebhookEvent = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    ...event,
  };

  const inserted = await pool.query(
    `INSERT INTO webhook_outbox (event_id, message_id, event_type, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [eventId, event.message_id, event.event_type, JSON.stringify(payload)]
  );

  if (inserted.rows.length === 0) {
    return;
  }

  const outboxId = inserted.rows[0].id as string;

  try {
    await postWebhook(payload);
    await pool.query(
      `UPDATE webhook_outbox
       SET status = 'delivered', delivered_at = NOW(), attempt_count = attempt_count + 1
       WHERE id = $1`,
      [outboxId]
    );
    await recordMessageEvent(pool, event.message_id, 'webhook_dispatched', {
      event_id: eventId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown webhook error';

    await pool.query(
      `UPDATE webhook_outbox
       SET attempt_count = attempt_count + 1,
           last_error = $2,
           next_attempt_at = NOW() + ($3 || ' seconds')::interval
       WHERE id = $1`,
      [outboxId, errorMessage, String(Math.ceil(config.WEBHOOK_RETRY_DELAY_MS / 1000))]
    );

    await getWebhookQueue().add(
      'deliver',
      {
        outboxId,
        eventId,
        messageId: event.message_id,
        tenantId: event.tenant_id,
        eventType: event.event_type,
        payload,
        metadata: event.metadata,
      },
      { jobId: eventId, delay: config.WEBHOOK_RETRY_DELAY_MS }
    );

    await recordMessageEvent(pool, event.message_id, 'webhook_failed', {
      event_id: eventId,
      error: errorMessage,
      will_retry: true,
    });

    log.warn('webhook failed, retry scheduled', {
      message_id: event.message_id,
      tenant_id: event.tenant_id,
      event: 'webhook_failed',
      error: errorMessage,
    });
  }
}

export async function closeWebhookQueue(): Promise<void> {
  if (!webhookQueue) {
    return;
  }

  const activeQueue = webhookQueue;
  webhookQueue = null;

  await Promise.race([
    activeQueue.close(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
}
