import type { Job } from 'bullmq';
import type { Pool } from 'pg';
import type { SendMessageJob } from '@vmds/shared';
import { createLogger } from '@vmds/shared';
import { recordMessageEvent } from './events.js';

const log = createLogger('worker');

export async function moveToDeadLetter(
  pool: Pool,
  job: Job<SendMessageJob>,
  reason: string
): Promise<void> {
  const { messageId, tenantId } = job.data;
  const attemptCount = job.attemptsMade + 1;

  await pool.query(
    `UPDATE messages
     SET status = 'dead_letter', error_message = $2, updated_at = NOW()
     WHERE id = $1`,
    [messageId, reason]
  );

  await pool.query(
    `INSERT INTO dead_letter_messages (message_id, tenant_id, failure_reason, attempt_count, job_payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_id) DO UPDATE
       SET failure_reason = EXCLUDED.failure_reason,
           attempt_count = EXCLUDED.attempt_count,
           job_payload = EXCLUDED.job_payload,
           moved_at = NOW()`,
    [messageId, tenantId, reason, attemptCount, JSON.stringify(job.data)]
  );

  await recordMessageEvent(pool, messageId, 'dead_letter', {
    reason,
    attempt_count: attemptCount,
  });

  log.warn('message moved to dead letter queue', {
    message_id: messageId,
    tenant_id: tenantId,
    event: 'dead_letter',
    attempt_count: attemptCount,
  });
}
