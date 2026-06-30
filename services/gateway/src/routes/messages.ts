import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  sendMessageSchema,
  type SendMessageResponse,
} from '@vmds/shared';
import { getPool } from '../lib/db.js';
import { getQueue } from '../lib/queue.js';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/messages', async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const body = parsed.data;
    const pool = getPool();

    const existing = await pool.query(
      `SELECT id, status, created_at FROM messages
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [body.tenant_id, body.idempotency_key]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const response: SendMessageResponse = {
        message_id: row.id,
        status: 'queued',
        queue: 'transaction',
        created_at: row.created_at.toISOString(),
      };
      return reply.code(200).send(response);
    }

    const messageId = randomUUID();
    const insert = await pool.query(
      `INSERT INTO messages (
        id, tenant_id, idempotency_key, status, queue,
        from_email, from_name, to_addresses, subject,
        content_html, content_text, metadata, tags
      ) VALUES ($1,$2,$3,'queued','transaction',$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, created_at`,
      [
        messageId,
        body.tenant_id,
        body.idempotency_key,
        body.from.email,
        body.from.name ?? null,
        JSON.stringify(body.to),
        body.subject,
        body.content.html ?? null,
        body.content.text ?? null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        body.tags ?? null,
      ]
    );

    const row = insert.rows[0];
    const queue = getQueue();

    await queue.add(
      'send',
      {
        messageId: row.id,
        tenantId: body.tenant_id,
        from: body.from,
        to: body.to,
        subject: body.subject,
        html: body.content.html,
        text: body.content.text,
        metadata: body.metadata,
      },
      { jobId: row.id }
    );

    const response: SendMessageResponse = {
      message_id: row.id,
      status: 'queued',
      queue: 'transaction',
      created_at: row.created_at.toISOString(),
    };

    return reply.code(202).send(response);
  });

  app.get<{ Params: { id: string } }>('/v1/messages/:id', async (request, reply) => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, tenant_id, status, queue, subject, to_addresses,
              smtp_response, error_message, attempt_count,
              created_at, updated_at, delivered_at, metadata
       FROM messages WHERE id = $1`,
      [request.params.id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Message not found' });
    }

    const row = result.rows[0];
    return reply.send({
      message_id: row.id,
      tenant_id: row.tenant_id,
      status: row.status,
      queue: row.queue,
      subject: row.subject,
      to: row.to_addresses,
      smtp_response: row.smtp_response,
      error_message: row.error_message,
      attempt_count: row.attempt_count,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      delivered_at: row.delivered_at,
    });
  });
}
