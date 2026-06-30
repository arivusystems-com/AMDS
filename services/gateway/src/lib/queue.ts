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
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });
  }
  return queue;
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
