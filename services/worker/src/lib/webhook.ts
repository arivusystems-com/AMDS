import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig, type WebhookEvent } from '@vmds/shared';

export async function sendWebhook(event: Omit<WebhookEvent, 'event_id' | 'timestamp'>): Promise<void> {
  const config = loadConfig();
  if (!config.LITEDESK_WEBHOOK_URL) {
    return;
  }

  const payload: WebhookEvent = {
    event_id: `evt_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    ...event,
  };

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
