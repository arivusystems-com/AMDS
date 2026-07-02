import type { FastifyInstance } from 'fastify';
import { createSuppressionSchema } from '@vmds/shared';
import { getPool } from '../lib/db.js';

export async function suppressionRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { tenant_id?: string; email?: string } }>(
    '/v1/suppressions',
    async (request, reply) => {
      const { tenant_id, email } = request.query;
      if (!tenant_id) {
        return reply.code(400).send({ error: 'tenant_id query parameter is required' });
      }

      const pool = getPool();
      const params: string[] = [tenant_id];
      let sql = `SELECT email, reason, source_message_id, created_at
                 FROM suppressions WHERE tenant_id = $1`;

      if (email) {
        params.push(email.toLowerCase());
        sql += ` AND email = $2`;
      }

      sql += ` ORDER BY created_at DESC LIMIT 1000`;

      const result = await pool.query(sql, params);
      return reply.send({
        tenant_id,
        suppressions: result.rows.map((row) => ({
          email: row.email,
          reason: row.reason,
          source_message_id: row.source_message_id,
          created_at: row.created_at,
        })),
      });
    }
  );

  app.post('/v1/suppressions', async (request, reply) => {
    const parsed = createSuppressionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { tenant_id, email, reason } = parsed.data;
    const pool = getPool();

    const result = await pool.query(
      `INSERT INTO suppressions (tenant_id, email, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING email, reason, source_message_id, created_at`,
      [tenant_id, email.toLowerCase(), reason]
    );

    return reply.code(201).send(result.rows[0]);
  });

  app.delete<{ Params: { email: string }; Querystring: { tenant_id?: string } }>(
    '/v1/suppressions/:email',
    async (request, reply) => {
      const tenantId = request.query.tenant_id;
      if (!tenantId) {
        return reply.code(400).send({ error: 'tenant_id query parameter is required' });
      }

      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM suppressions WHERE tenant_id = $1 AND email = $2 RETURNING email`,
        [tenantId, request.params.email.toLowerCase()]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Suppression not found' });
      }

      return reply.code(204).send();
    }
  );
}
