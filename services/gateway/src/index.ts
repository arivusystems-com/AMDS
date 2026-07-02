import Fastify from 'fastify';
import { loadConfig } from '@vmds/shared';
import { createAuthHook } from './lib/auth.js';
import { closePool } from './lib/db.js';
import { closeQueue } from './lib/queue.js';
import { closeCampaignQueue } from './lib/campaign-queue.js';
import { closeWebhookQueue } from './lib/webhook-dispatch.js';
import { closeRedis } from './lib/redis.js';
import { healthRoutes } from './routes/health.js';
import { messageRoutes } from './routes/messages.js';
import { domainRoutes } from './routes/domains.js';
import { suppressionRoutes } from './routes/suppressions.js';
import { adminRoutes } from './routes/admin.js';
import { campaignRoutes } from './routes/campaigns.js';
import { reputationRoutes } from './routes/reputation.js';
import { throughputRoutes } from './routes/throughput.js';
import { tenantRoutes } from './routes/tenants.js';
import { trackingRoutes } from './routes/tracking.js';
import { analyticsRoutes } from './routes/analytics.js';
import { metricsRoutes } from './routes/metrics.js';
import { openapiRoutes } from './routes/openapi.js';
import {
  httpRequestDuration,
  httpRequestsTotal,
  routeLabel,
} from './lib/metrics.js';

const config = loadConfig();

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

let app: ReturnType<typeof Fastify> | null = null;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  shuttingDown = true;

  const isDev = config.NODE_ENV !== 'production';
  const budgetMs = isDev ? DEV_SHUTDOWN_MS : shutdownGraceMs();
  app?.log.info({ signal, grace_ms: budgetMs }, 'Shutting down gateway...');

  const forceExit = setTimeout(() => process.exit(0), budgetMs);
  if (!isDev) {
    forceExit.unref();
  }

  const cleanup: Array<Promise<unknown>> = [];
  if (app) {
    cleanup.push(withShutdownTimeout(app.close(), budgetMs));
  }
  cleanup.push(
    withShutdownTimeout(closeQueue(), budgetMs),
    withShutdownTimeout(closeCampaignQueue(), budgetMs),
    withShutdownTimeout(closeWebhookQueue(), budgetMs),
    withShutdownTimeout(closeRedis(), budgetMs),
    withShutdownTimeout(closePool(), budgetMs)
  );

  if (isDev) {
    void Promise.allSettled(cleanup).finally(() => finishShutdown(forceExit));
    return;
  }

  try {
    await Promise.all(cleanup);
  } catch (err) {
    app?.log.error(err, 'Error during shutdown');
  } finally {
    finishShutdown(forceExit);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

app = Fastify({
  logger: {
    level: config.NODE_ENV === 'development' ? 'info' : 'warn',
  },
});

app.addHook('onRequest', createAuthHook());

app.addHook('onResponse', async (request, reply) => {
  const config = loadConfig();
  if (!config.METRICS_ENABLED) {
    return;
  }

  const route = routeLabel(request.url);
  const status = String(reply.statusCode);
  httpRequestsTotal.inc({ method: request.method, route, status });
  const elapsed = reply.elapsedTime / 1000;
  httpRequestDuration.observe({ method: request.method, route }, elapsed);
});

await healthRoutes(app);
await messageRoutes(app);
await domainRoutes(app);
await suppressionRoutes(app);
await adminRoutes(app);
await campaignRoutes(app);
await tenantRoutes(app);
await reputationRoutes(app);
await throughputRoutes(app);
await trackingRoutes(app);
await analyticsRoutes(app);
await metricsRoutes(app);
await openapiRoutes(app);

try {
  await app.listen({ port: config.AMDS_PORT, host: '0.0.0.0' });
  app.log.info(`AMDS Gateway listening on http://localhost:${config.AMDS_PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
