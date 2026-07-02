import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const specPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/openapi-track6.yaml');

export async function openapiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/openapi.yaml', async (_request, reply) => {
    const body = readFileSync(specPath, 'utf8');
    return reply.header('Content-Type', 'application/yaml').send(body);
  });

  app.get('/v1/openapi.json', async (_request, reply) => {
    return reply.send({
      openapi: '3.0.3',
      info: {
        title: 'AMDS Track 6 API',
        version: '1.0.0',
        description: 'Tenant policies, reputation, throughput, campaign health. Full spec: GET /v1/openapi.yaml',
      },
      externalDocs: {
        url: '/v1/openapi.yaml',
        description: 'OpenAPI YAML specification',
      },
    });
  });
}
