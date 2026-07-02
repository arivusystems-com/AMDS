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

export async function getMessageEvents(pool: Pool, messageId: string) {
  const result = await pool.query(
    `SELECT event_type, detail, created_at
     FROM message_events
     WHERE message_id = $1
     ORDER BY created_at ASC`,
    [messageId]
  );
  return result.rows.map((row) => ({
    event_type: row.event_type,
    detail: row.detail,
    created_at: row.created_at,
  }));
}
