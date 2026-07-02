import { Queue } from 'bullmq';
import { loadConfig, CAMPAIGN_QUEUE_NAME, type SendMessageJob } from '@vmds/shared';

let queue: Queue<SendMessageJob> | null = null;

export function getCampaignQueue(): Queue<SendMessageJob> {
  if (!queue) {
    const config = loadConfig();
    queue = new Queue<SendMessageJob>(CAMPAIGN_QUEUE_NAME, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: {
        removeOnComplete: 5000,
        removeOnFail: 10000,
        attempts: config.SMTP_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: config.SMTP_RETRY_DELAY_MS },
      },
    });
  }
  return queue;
}

export async function closeCampaignQueue(): Promise<void> {
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
