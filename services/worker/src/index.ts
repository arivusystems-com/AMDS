import { Worker } from 'bullmq';
import { loadConfig, QUEUE_NAME, type SendMessageJob } from '@vmds/shared';
import { closePool } from './lib/db.js';
import { processSendJob } from './processor.js';

const config = loadConfig();

const worker = new Worker<SendMessageJob>(
  QUEUE_NAME,
  processSendJob,
  {
    connection: { url: config.REDIS_URL },
    concurrency: 5,
  }
);

worker.on('ready', () => {
  console.log(`[worker] listening on queue "${QUEUE_NAME}"`);
  console.log(`[worker] SMTP → ${config.SMTP_HOST}:${config.SMTP_PORT}`);
});

worker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

async function shutdown(): Promise<void> {
  console.log('[worker] shutting down...');
  await worker.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
