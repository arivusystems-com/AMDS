import { Worker } from 'bullmq';
import {
  loadConfig,
  QUEUE_NAME,
  CAMPAIGN_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
  createLogger,
  type SendMessageJob,
  type WebhookJob,
} from '@vmds/shared';
import { closePool, getPool } from './lib/db.js';
import { moveToDeadLetter } from './lib/dead-letter.js';
import {
  closeWebhookQueue,
  deliverWebhookJob,
  markWebhookExhausted,
} from './lib/webhook.js';
import { processSendJob } from './processor.js';
import {
  closeWorkerMetricsServer,
  recordDelivery,
  startWorkerMetricsServer,
} from './lib/metrics.js';

const config = loadConfig();
const log = createLogger('worker');

let shuttingDown = false;

const DEV_SHUTDOWN_MS = 300;

function shutdownGraceMs(): number {
  if (config.NODE_ENV === 'production') {
    return Math.max(config.SHUTDOWN_GRACE_MS, 5_000);
  }
  return config.SHUTDOWN_GRACE_MS;
}

function withShutdownTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  ]);
}

function finishShutdown(forceExit: ReturnType<typeof setTimeout>): void {
  clearTimeout(forceExit);
  process.exit(0);
}

let sendWorker: Worker<SendMessageJob> | undefined;
let campaignWorker: Worker<SendMessageJob> | undefined;
let webhookWorker: Worker<WebhookJob> | undefined;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  shuttingDown = true;

  const isDev = config.NODE_ENV !== 'production';
  const budgetMs = isDev ? DEV_SHUTDOWN_MS : shutdownGraceMs();
  log.info('shutting down workers', { event: 'shutdown', grace_ms: budgetMs });

  const forceExit = setTimeout(() => process.exit(0), budgetMs);
  if (!isDev) {
    forceExit.unref();
  }

  const forceClose = isDev;
  const cleanup: Array<Promise<unknown>> = [];
  if (sendWorker) {
    cleanup.push(withShutdownTimeout(sendWorker.close(forceClose), budgetMs));
  }
  if (campaignWorker) {
    cleanup.push(withShutdownTimeout(campaignWorker.close(forceClose), budgetMs));
  }
  if (webhookWorker) {
    cleanup.push(withShutdownTimeout(webhookWorker.close(forceClose), budgetMs));
  }
  cleanup.push(
    withShutdownTimeout(closeWebhookQueue(), budgetMs),
    withShutdownTimeout(closePool(), budgetMs),
    withShutdownTimeout(closeWorkerMetricsServer(), budgetMs)
  );

  if (isDev) {
    void Promise.allSettled(cleanup).finally(() => finishShutdown(forceExit));
    return;
  }

  try {
    await Promise.all(cleanup);
  } finally {
    finishShutdown(forceExit);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

sendWorker = new Worker<SendMessageJob>(
  QUEUE_NAME,
  processSendJob,
  {
    connection: { url: config.REDIS_URL },
    concurrency: config.TRANSACTION_WORKER_CONCURRENCY,
  }
);

campaignWorker = new Worker<SendMessageJob>(
  CAMPAIGN_QUEUE_NAME,
  processSendJob,
  {
    connection: { url: config.REDIS_URL },
    concurrency: config.CAMPAIGN_WORKER_CONCURRENCY,
  }
);

webhookWorker = new Worker<WebhookJob>(
  WEBHOOK_QUEUE_NAME,
  deliverWebhookJob,
  {
    connection: { url: config.REDIS_URL },
    concurrency: config.WEBHOOK_WORKER_CONCURRENCY,
  }
);

startWorkerMetricsServer();

sendWorker.on('ready', () => {
  log.info('send worker ready', {
    event: 'worker_ready',
    queue: QUEUE_NAME,
    smtp_mode: config.SMTP_MODE,
    smtp_target: `${config.SMTP_HOST}:${config.SMTP_PORT}`,
  });
});

campaignWorker.on('ready', () => {
  log.info('campaign worker ready', {
    event: 'worker_ready',
    queue: CAMPAIGN_QUEUE_NAME,
    concurrency: config.CAMPAIGN_WORKER_CONCURRENCY,
  });
});

webhookWorker.on('ready', () => {
  log.info('webhook worker ready', { event: 'worker_ready', queue: WEBHOOK_QUEUE_NAME });
});

campaignWorker.on('failed', async (job, err) => {
  if (!job) {
    return;
  }

  const maxAttempts = job.opts.attempts ?? config.SMTP_MAX_ATTEMPTS;
  if (job.attemptsMade >= maxAttempts) {
    const pool = getPool();
    await moveToDeadLetter(pool, job, err.message);
    try {
      const { dispatchWebhook } = await import('./lib/webhook.js');
      await dispatchWebhook({
        event_type: 'message.failed',
        tenant_id: job.data.tenantId,
        message_id: job.data.messageId,
        metadata: job.data.metadata,
        delivery: {
          recipient: job.data.to[0].email,
          attempt: job.attemptsMade,
          error: err.message,
        },
      });
    } catch (webhookErr) {
      log.error('failed to dispatch failure webhook after dead letter', {
        message_id: job.data.messageId,
        error: webhookErr instanceof Error ? webhookErr.message : 'unknown',
      });
    }
  }

  log.error('campaign send job failed', {
    message_id: job.data.messageId,
    tenant_id: job.data.tenantId,
    attempt: job.attemptsMade,
    error: err.message,
  });
});

sendWorker.on('failed', async (job, err) => {
  if (!job) {
    return;
  }

  const maxAttempts = job.opts.attempts ?? config.SMTP_MAX_ATTEMPTS;
  if (job.attemptsMade >= maxAttempts) {
    const pool = getPool();
    await moveToDeadLetter(pool, job, err.message);
    try {
      const { dispatchWebhook } = await import('./lib/webhook.js');
      await dispatchWebhook({
        event_type: 'message.failed',
        tenant_id: job.data.tenantId,
        message_id: job.data.messageId,
        metadata: job.data.metadata,
        delivery: {
          recipient: job.data.to[0].email,
          attempt: job.attemptsMade,
          error: err.message,
        },
      });
    } catch (webhookErr) {
      log.error('failed to dispatch failure webhook after dead letter', {
        message_id: job.data.messageId,
        error: webhookErr instanceof Error ? webhookErr.message : 'unknown',
      });
    }
  }

  log.error('send job failed', {
    message_id: job.data.messageId,
    tenant_id: job.data.tenantId,
    attempt: job.attemptsMade,
    error: err.message,
  });
});

webhookWorker.on('failed', async (job, err) => {
  if (!job) {
    return;
  }

  const maxAttempts = job.opts.attempts ?? config.WEBHOOK_MAX_ATTEMPTS;
  if (job.attemptsMade >= maxAttempts) {
    await markWebhookExhausted(job, err.message);
  }

  log.error('webhook job failed', {
    message_id: job.data.messageId,
    event_id: job.data.eventId,
    attempt: job.attemptsMade,
    error: err.message,
  });
});

