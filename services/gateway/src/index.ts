import Fastify from 'fastify';
import { loadConfig } from '@vmds/shared';
import { createAuthHook } from './lib/auth.js';
import { closePool } from './lib/db.js';
import { closeQueue } from './lib/queue.js';
import { healthRoutes } from './routes/health.js';
import { messageRoutes } from './routes/messages.js';

const config = loadConfig();

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'development' ? 'info' : 'warn',
  },
});

app.addHook('onRequest', createAuthHook());
await healthRoutes(app);
await messageRoutes(app);

async function shutdown(): Promise<void> {
  app.log.info('Shutting down gateway...');
  await app.close();
  await closeQueue();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: config.AMDS_PORT, host: '0.0.0.0' });
  app.log.info(`AMDS Gateway listening on http://localhost:${config.AMDS_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
