import type { Pool } from 'pg';
import type { MessageEventType } from '@vmds/shared';

export async function recordMessageEvent(
  pool: Pool,
  messageId: string,
  eventType: MessageEventType,
  detail?: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO message_events (message_id, event_type, detail) VALUES ($1, $2, $3)`,
    [messageId, eventType, detail ? JSON.stringify(detail) : null]
  );
}
