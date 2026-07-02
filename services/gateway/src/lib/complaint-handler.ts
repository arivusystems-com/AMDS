import type { Pool } from 'pg';
import { dispatchWebhookFromGateway } from './webhook-client.js';
import { recordMessageEvent } from './events.js';
import { recordReputationSignal } from './reputation-engine.js';

export interface ComplaintInput {
  tenantId: string;
  messageId: string;
  recipient: string;
  metadata?: Record<string, unknown>;
}

export async function processComplaint(pool: Pool, input: ComplaintInput) {
  const { tenantId, messageId, recipient, metadata } = input;

  await recordMessageEvent(pool, messageId, 'complained', {
    recipient,
  });

  await pool.query(
    `INSERT INTO suppressions (tenant_id, email, reason, source_message_id)
     VALUES ($1, $2, 'complaint', $3)
     ON CONFLICT (tenant_id, email) DO UPDATE
       SET reason = 'complaint', source_message_id = EXCLUDED.source_message_id`,
    [tenantId, recipient.toLowerCase(), messageId]
  );

  void recordReputationSignal(pool, {
    tenantId,
    messageId,
    signalType: 'complaint',
    detail: { recipient },
  });

  try {
    await dispatchWebhookFromGateway({
      event_type: 'message.complained',
      tenant_id: tenantId,
      message_id: messageId,
      metadata,
      engagement: {
        recipient,
        hit_count: 1,
      },
    });
  } catch {
    // complaint state persisted
  }

  return {
    message_id: messageId,
    status: 'complained',
    suppressed: true,
    recipient,
  };
}
