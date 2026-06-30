import type { Job } from 'bullmq';
import type { SendMessageJob } from '@vmds/shared';
import { getPool } from './lib/db.js';
import { getTransporter } from './lib/smtp.js';
import { sendWebhook } from './lib/webhook.js';

export async function processSendJob(job: Job<SendMessageJob>): Promise<void> {
  const { messageId, tenantId, from, to, subject, html, text, metadata } = job.data;
  const pool = getPool();
  const transporter = getTransporter();

  await pool.query(
    `UPDATE messages SET status = 'processing', attempt_count = attempt_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [messageId]
  );

  const primaryRecipient = to[0].email;

  try {
    const info = await transporter.sendMail({
      from: from.name ? `"${from.name}" <${from.email}>` : from.email,
      to: to.map((r) => (r.name ? `"${r.name}" <${r.email}>` : r.email)).join(', '),
      subject,
      html,
      text: text ?? (html ? undefined : subject),
    });

    const smtpResponse = info.response ?? '250 OK';

    await pool.query(
      `UPDATE messages
       SET status = 'delivered', smtp_response = $2, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [messageId, smtpResponse]
    );

    try {
      await sendWebhook({
        event_type: 'message.delivered',
        tenant_id: tenantId,
        message_id: messageId,
        metadata,
        delivery: {
          recipient: primaryRecipient,
          smtp_response: smtpResponse,
          attempt: job.attemptsMade + 1,
        },
      });
    } catch (webhookErr) {
      const webhookMessage =
        webhookErr instanceof Error ? webhookErr.message : 'Unknown webhook error';
      console.error(
        `[worker] webhook failed after SMTP delivery for ${messageId}: ${webhookMessage}`
      );
    }

    console.log(`[worker] delivered ${messageId} → ${primaryRecipient}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';

    await pool.query(
      `UPDATE messages
       SET status = 'failed', error_message = $2, updated_at = NOW()
       WHERE id = $1`,
      [messageId, errorMessage]
    );

    try {
      await sendWebhook({
        event_type: 'message.failed',
        tenant_id: tenantId,
        message_id: messageId,
        metadata,
        delivery: {
          recipient: primaryRecipient,
          attempt: job.attemptsMade + 1,
          error: errorMessage,
        },
      });
    } catch (webhookErr) {
      const webhookMessage =
        webhookErr instanceof Error ? webhookErr.message : 'Unknown webhook error';
      console.error(
        `[worker] webhook failed after SMTP failure for ${messageId}: ${webhookMessage}`
      );
    }

    throw err;
  }
}
