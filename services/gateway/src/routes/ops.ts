import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@vmds/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadOpsHtml(): string {
  const candidates = [
    join(__dirname, '../../public/ops.html'),
    join(__dirname, '../public/ops.html'),
    join(process.cwd(), 'services/gateway/public/ops.html'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h1>AMDS Ops</h1><p>ops.html not found. Ensure services/gateway/public/ops.html is deployed.</p></body></html>`;
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  const html = loadOpsHtml();

  app.get('/ops', async (_request, reply) => {
    const config = loadConfig();
    if (!config.OPS_UI_ENABLED) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').send(html);
  });

  app.get('/ops/', async (_request, reply) => {
    const config = loadConfig();
    if (!config.OPS_UI_ENABLED) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.type('text/html').send(html);
  });
}
