import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig, createLogger, type TenantWebhookEvent } from '@vmds/shared';
import { getPool } from './db.js';

const log = createLogger('worker');

async function postTenantWebhook(payload: TenantWebhookEvent): Promise<void> {
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
    throw new Error(`Tenant webhook failed: ${response.status} ${response.statusText}`);
  }
}

export async function dispatchTenantWebhook(
  event: Omit<TenantWebhookEvent, 'event_id' | 'timestamp'>
): Promise<void> {
  const config = loadConfig();
  if (!config.LITEDESK_WEBHOOK_URL) {
    return;
  }

  const pool = getPool();
  const eventId = `evt_${randomUUID()}`;
  const payload: TenantWebhookEvent = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    ...event,
  };

  await pool.query(
    `INSERT INTO webhook_outbox (event_id, message_id, event_type, payload, status, delivered_at)
     VALUES ($1, $2, $3, $4, 'delivered', NOW())`,
    [eventId, event.message_id ?? null, event.event_type, JSON.stringify(payload)]
  );

  try {
    await postTenantWebhook(payload);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown webhook error';
    log.warn('tenant webhook failed', {
      tenant_id: event.tenant_id,
      event_type: event.event_type,
      error: errorMessage,
    });
    await pool.query(
      `UPDATE webhook_outbox
       SET status = 'pending', last_error = $2, delivered_at = NULL
       WHERE event_id = $1`,
      [eventId, errorMessage]
    );
  }
}
