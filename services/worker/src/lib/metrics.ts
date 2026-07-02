import http from 'node:http';
import client from 'prom-client';
import { loadConfig } from '@vmds/shared';

const register = new client.Registry();

client.collectDefaultMetrics({ register, prefix: 'amds_worker_' });

export const deliveriesTotal = new client.Counter({
  name: 'amds_worker_deliveries_total',
  help: 'SMTP delivery outcomes',
  labelNames: ['queue', 'result'] as const,
  registers: [register],
});

export function recordDelivery(queue: 'transaction' | 'campaign', result: 'success' | 'failure'): void {
  deliveriesTotal.inc({ queue, result });
}

let server: http.Server | null = null;

export function startWorkerMetricsServer(): void {
  const config = loadConfig();
  if (!config.METRICS_ENABLED) {
    return;
  }

  server = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': register.contentType });
    res.end(await register.metrics());
  });

  server.listen(config.WORKER_METRICS_PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'worker metrics listening',
        port: config.WORKER_METRICS_PORT,
      })
    );
  });
}

export async function closeWorkerMetricsServer(): Promise<void> {
  if (!server) {
    return;
  }

  const active = server;
  server = null;

  active.closeAllConnections?.();

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      active.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
}
