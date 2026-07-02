import type { Pool } from 'pg';
import { dispatchWebhookFromGateway } from './webhook-client.js';
import { recordMessageEvent } from './events.js';
import { recordReputationSignal } from './reputation-engine.js';

export interface BounceInput {
  tenantId: string;
  messageId: string;
  recipient: string;
  classification: 'hard' | 'soft';
  diagnostic: string;
  statusCode: string | null;
  metadata?: Record<string, unknown>;
}

export async function processBounce(pool: Pool, input: BounceInput) {
  const { tenantId, messageId, recipient, classification, diagnostic, statusCode, metadata } =
    input;

  await pool.query(
    `UPDATE messages SET status = 'bounced', error_message = $2, updated_at = NOW() WHERE id = $1`,
    [messageId, diagnostic]
  );

  await recordMessageEvent(pool, messageId, 'bounced', {
    recipient,
    classification,
    diagnostic,
    status_code: statusCode,
  });

  let suppressed = false;
  if (classification === 'hard') {
    await pool.query(
      `INSERT INTO suppressions (tenant_id, email, reason, source_message_id)
       VALUES ($1, $2, 'hard_bounce', $3)
       ON CONFLICT (tenant_id, email) DO UPDATE
         SET reason = 'hard_bounce', source_message_id = EXCLUDED.source_message_id`,
      [tenantId, recipient.toLowerCase(), messageId]
    );
    suppressed = true;
  }

  void recordReputationSignal(pool, {
    tenantId,
    messageId,
    signalType: classification === 'hard' ? 'hard_bounce' : 'soft_bounce',
    detail: { recipient, classification },
  });

  try {
    await dispatchWebhookFromGateway({
      event_type: 'message.bounced',
      tenant_id: tenantId,
      message_id: messageId,
      metadata,
      bounce: {
        recipient,
        classification,
        diagnostic,
        status_code: statusCode,
      },
    });
  } catch {
    // Bounce state is persisted; webhook retry can be added in a future track
  }

  return {
    message_id: messageId,
    status: 'bounced',
    classification,
    suppressed,
    recipient,
  };
}
