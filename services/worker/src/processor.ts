import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  RetryableSmtpError,
  PermanentSmtpError,
  loadConfig,
  createLogger,
  CAMPAIGN_QUEUE_NAME,
  attributeFailureClass,
  shouldAffectInfraPressure,
  shouldAffectTenantReputation,
  bounceSignalForFailure,
  type SendMessageJob,
} from '@vmds/shared';
import { getPool } from './lib/db.js';
import { recordMessageEvent } from './lib/events.js';
import { moveToDeadLetter } from './lib/dead-letter.js';
import { getDkimForSender } from './lib/domains.js';
import { sendMail } from './lib/smtp.js';
import { dispatchWebhook } from './lib/webhook.js';
import { applyTrackingToHtml } from './lib/tracking.js';
import { recordDelivery } from './lib/metrics.js';
import { consumeCredit, releaseCredit } from './lib/credits.js';
import { recordReputationSignal } from './lib/reputation-engine.js';
import { getEffectiveHourlyRate } from './lib/throughput-engine.js';
import { acquireDeliverySlot } from './lib/throughput-pacing.js';
import { resolveEgressIpForSend, assertEgressBindable } from './lib/ip-pools.js';
import { checkEgressCap, recordEgressSend } from './lib/egress-ip.js';
import { recordSmtpOutcome } from './lib/infra-state.js';
import {
  resolveLayeredHourlyRate,
  acquireProviderSlot,
  acquirePoolSlot,
} from './lib/layered-limits.js';

const log = createLogger('worker');

function deliveryQueueLabel(job: Job<SendMessageJob>): 'transaction' | 'campaign' {
  return job.queueName === CAMPAIGN_QUEUE_NAME ? 'campaign' : 'transaction';
}

function applyTestSimulation(
  job: Job<SendMessageJob>
): RetryableSmtpError | PermanentSmtpError | null {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    return null;
  }

  const simulation = job.data.metadata?.test_simulate;
  if (simulation === 'soft_fail') {
    const maxFails = Number(job.data.metadata?.test_simulate_attempts ?? 2);
    if (job.attemptsMade < maxFails) {
      return new RetryableSmtpError(
        `Simulated transient SMTP failure (attempt ${job.attemptsMade + 1})`
      );
    }
  }

  if (simulation === 'hard_fail') {
    return new PermanentSmtpError('Simulated permanent SMTP failure');
  }

  return null;
}

export async function processSendJob(job: Job<SendMessageJob>): Promise<void> {
  const { messageId, tenantId, from, to, subject, html, text, metadata } = job.data;
  const pool = getPool();
  const config = loadConfig();
  const attempt = job.attemptsMade + 1;
  const queueType = deliveryQueueLabel(job);
  const primaryRecipient = to[0].email;

  const egress = await resolveEgressIpForSend(pool, tenantId, queueType);

  try {
    assertEgressBindable(egress.egress_ip, config.EGRESS_BIND_REQUIRED);
  } catch (bindErr) {
    const msg = bindErr instanceof Error ? bindErr.message : 'Egress bind failure';
    await pool.query(
      `UPDATE messages
       SET status = 'failed', error_message = $2, failure_class = 'infra',
           egress_ip = $3, ip_pool_id = $4, updated_at = NOW()
       WHERE id = $1`,
      [messageId, msg, egress.egress_ip, egress.pool_id]
    );
    await recordMessageEvent(pool, messageId, 'failed', {
      error: msg,
      failure_class: 'infra',
      attempt,
    });
    void recordSmtpOutcome(false);
    throw new RetryableSmtpError(msg);
  }

  const tenantEffective = await getEffectiveHourlyRate(pool, tenantId, queueType);
  const layered = await resolveLayeredHourlyRate({
    tenantEffectiveHourly: tenantEffective,
    poolHourlyLimit: egress.hourly_send_limit,
    recipientEmail: primaryRecipient,
  });

  const slot = await acquireDeliverySlot(tenantId, layered.hourly);
  if (!slot.allowed) {
    await job.moveToDelayed(Date.now() + slot.retryAfterMs, job.token);
    throw new DelayedError('Throughput pacing');
  }

  const poolSlot = await acquirePoolSlot(egress.pool_id, egress.hourly_send_limit);
  if (!poolSlot.allowed) {
    await job.moveToDelayed(Date.now() + poolSlot.retryAfterMs, job.token);
    throw new DelayedError('Pool hourly limit');
  }

  const providerSlot = await acquireProviderSlot(layered.provider, layered.providerLimit);
  if (!providerSlot.allowed) {
    await job.moveToDelayed(Date.now() + providerSlot.retryAfterMs, job.token);
    throw new DelayedError('Provider hourly limit');
  }

  const cap = await checkEgressCap(pool, egress.egress_ip);
  if (!cap.allowed) {
    await job.moveToDelayed(Date.now() + cap.retry_after_ms, job.token);
    throw new DelayedError('Egress IP warm-up cap');
  }

  const simulated = applyTestSimulation(job);
  if (simulated) {
    if (simulated instanceof PermanentSmtpError) {
      await pool.query(
        `UPDATE messages
         SET status = 'processing', attempt_count = $2, updated_at = NOW()
         WHERE id = $1`,
        [messageId, attempt]
      );
      await recordMessageEvent(pool, messageId, 'processing', { attempt, simulated: true });
      await moveToDeadLetter(pool, job, simulated.message);
      await releaseCredit(pool, tenantId, messageId);
      try {
        await dispatchWebhook({
          event_type: 'message.failed',
          tenant_id: tenantId,
          message_id: messageId,
          metadata,
          delivery: {
            recipient: to[0].email,
            attempt,
            error: simulated.message,
          },
        });
      } catch {
        // webhook retry handles persistence
      }
      throw new UnrecoverableError(simulated.message);
    }
    throw simulated;
  }

  await pool.query(
    `UPDATE messages
     SET status = 'processing', attempt_count = $2,
         egress_ip = $3, ip_pool_id = $4, updated_at = NOW()
     WHERE id = $1`,
    [messageId, attempt, egress.egress_ip, egress.pool_id]
  );

  await recordMessageEvent(pool, messageId, 'processing', {
    attempt,
    pool_id: egress.pool_id,
    egress_ip: egress.egress_ip,
    risk_tier: egress.risk_tier,
    source: egress.source,
  });
  await recordMessageEvent(pool, messageId, 'delivery_attempt', {
    attempt,
    pool_id: egress.pool_id,
    egress_ip: egress.egress_ip,
  });

  log.info('processing send job', {
    message_id: messageId,
    tenant_id: tenantId,
    event: 'delivery_attempt',
    attempt,
    pool_id: egress.pool_id,
    egress_ip: egress.egress_ip,
  });

  try {
    const dkim = await getDkimForSender(pool, tenantId, from.email);
    const trackedHtml = await applyTrackingToHtml(pool, messageId, html);
    const listUnsubscribeUrl =
      queueType === 'campaign'
        ? `${config.TRACKING_BASE_URL}/u/${messageId}`
        : undefined;

    const info = await sendMail({
      from,
      to,
      subject,
      html: trackedHtml,
      text,
      dkim: dkim ?? undefined,
      localAddress: egress.egress_ip,
      listUnsubscribeUrl,
    });
    const smtpResponse = info.response;

    await pool.query(
      `UPDATE messages
       SET status = 'delivered', smtp_response = $2, delivered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [messageId, smtpResponse]
    );

    await recordMessageEvent(pool, messageId, 'delivered', {
      recipient: primaryRecipient,
      smtp_response: smtpResponse,
      attempt,
      pool_id: egress.pool_id,
      egress_ip: egress.egress_ip,
    });

    await consumeCredit(pool, tenantId, messageId);

    void recordReputationSignal(pool, {
      tenantId,
      messageId,
      signalType: 'delivered',
    });

    try {
      await dispatchWebhook({
        event_type: 'message.delivered',
        tenant_id: tenantId,
        message_id: messageId,
        metadata,
        delivery: {
          recipient: primaryRecipient,
          smtp_response: smtpResponse,
          attempt,
        },
      });
    } catch (webhookErr) {
      const webhookMessage =
        webhookErr instanceof Error ? webhookErr.message : 'Unknown webhook error';
      log.error('webhook dispatch error after delivery', {
        message_id: messageId,
        tenant_id: tenantId,
        error: webhookMessage,
      });
    }

    log.info('message delivered', {
      message_id: messageId,
      tenant_id: tenantId,
      event: 'delivered',
      recipient: primaryRecipient,
    });

    recordDelivery(deliveryQueueLabel(job), 'success');
    void recordSmtpOutcome(true);
    await recordEgressSend(pool, egress.egress_ip);
  } catch (err) {
    const classified =
      err instanceof RetryableSmtpError || err instanceof PermanentSmtpError
        ? err
        : null;
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const isPermanent =
      err instanceof UnrecoverableError ||
      classified instanceof PermanentSmtpError;

    const failureClass = attributeFailureClass(err);
    const affectInfra = shouldAffectInfraPressure(failureClass);
    const bounceSignal = bounceSignalForFailure(failureClass, isPermanent);

    await pool.query(
      `UPDATE messages
       SET status = $2, error_message = $3, failure_class = $4, updated_at = NOW()
       WHERE id = $1`,
      [messageId, isPermanent ? 'failed' : 'processing', errorMessage, failureClass]
    );

    await recordMessageEvent(pool, messageId, 'failed', {
      recipient: primaryRecipient,
      error: errorMessage,
      attempt,
      retryable: !isPermanent,
      failure_class: failureClass,
    });

    if (bounceSignal && shouldAffectTenantReputation(failureClass)) {
      void recordReputationSignal(pool, {
        tenantId,
        messageId,
        signalType: bounceSignal,
        detail: { failure_class: failureClass, error: errorMessage },
      });
    }

    if (isPermanent) {
      recordDelivery(deliveryQueueLabel(job), 'failure');
      if (affectInfra) {
        void recordSmtpOutcome(false);
      }
      await releaseCredit(pool, tenantId, messageId);
      await moveToDeadLetter(pool, job, errorMessage);
      try {
        await dispatchWebhook({
          event_type: 'message.failed',
          tenant_id: tenantId,
          message_id: messageId,
          metadata,
          delivery: {
            recipient: primaryRecipient,
            attempt,
            error: errorMessage,
          },
        });
      } catch {
        // webhook retry handles persistence
      }
      throw new UnrecoverableError(errorMessage);
    }

    log.warn('delivery attempt failed', {
      message_id: messageId,
      tenant_id: tenantId,
      event: 'failed',
      attempt,
      retryable: !isPermanent,
      failure_class: failureClass,
      error: errorMessage,
    });

    if (affectInfra) {
      void recordSmtpOutcome(false);
    }

    throw err instanceof Error ? err : new Error(errorMessage);
  }
}
