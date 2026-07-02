import { Queue } from 'bullmq';
import { loadConfig, QUEUE_NAME, type SendMessageJob } from '@vmds/shared';

let queue: Queue<SendMessageJob> | null = null;

export function getQueue(): Queue<SendMessageJob> {
  if (!queue) {
    const config = loadConfig();
    queue = new Queue<SendMessageJob>(QUEUE_NAME, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: config.SMTP_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.SMTP_RETRY_DELAY_MS },
      },
    });
  }
  return queue;
}

export async function closeQueue(): Promise<void> {
  if (!queue) {
    return;
  }

  const activeQueue = queue;
  queue = null;

  await Promise.race([
    activeQueue.close(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
}
