import type { FastifyInstance } from 'fastify';
import {
  registerDomainSchema,
  verifyDomainSchema,
  type DomainResponse,
} from '@vmds/shared';
import { getPool } from '../lib/db.js';
import {
  buildDnsRecords,
  generateDkimKeyPair,
  verifyDomainDns,
} from '../lib/domains.js';

function toDomainResponse(row: Record<string, unknown>): DomainResponse {
  const dnsRecords = buildDnsRecords(
    row.domain as string,
    row.dkim_selector as string,
    row.dkim_public_key as string
  );

  return {
    domain: row.domain as string,
    tenant_id: row.tenant_id as string,
    status: row.status as 'pending' | 'verified',
    dkim_selector: row.dkim_selector as string,
    dns_records: dnsRecords,
    spf_verified: row.spf_verified as boolean,
    dkim_verified: row.dkim_verified as boolean,
    dmarc_verified: row.dmarc_verified as boolean,
    verified_at: row.verified_at
      ? (row.verified_at as Date).toISOString()
      : null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/domains', async (request, reply) => {
    const parsed = registerDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { tenant_id, domain } = parsed.data;
    const normalizedDomain = domain.toLowerCase();
    const pool = getPool();

    const existing = await pool.query(
      `SELECT * FROM domains WHERE tenant_id = $1 AND domain = $2`,
      [tenant_id, normalizedDomain]
    );

    if (existing.rows.length > 0) {
      return reply.code(200).send(toDomainResponse(existing.rows[0]));
    }

    const keys = generateDkimKeyPair();

    const insert = await pool.query(
      `INSERT INTO domains (
        tenant_id, domain, status, dkim_selector,
        dkim_private_key, dkim_public_key
      ) VALUES ($1, $2, 'pending', $3, $4, $5)
      RETURNING *`,
      [tenant_id, normalizedDomain, keys.selector, keys.privateKey, keys.publicKey]
    );

    return reply.code(201).send(toDomainResponse(insert.rows[0]));
  });

  app.get<{ Params: { domain: string }; Querystring: { tenant_id?: string } }>(
    '/v1/domains/:domain',
    async (request, reply) => {
      const tenantId = request.query.tenant_id;
      if (!tenantId) {
        return reply.code(400).send({ error: 'tenant_id query parameter is required' });
      }

      const pool = getPool();
      const result = await pool.query(
        `SELECT * FROM domains WHERE tenant_id = $1 AND domain = $2`,
        [tenantId, request.params.domain.toLowerCase()]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      return reply.send(toDomainResponse(result.rows[0]));
    }
  );

  app.post<{ Params: { domain: string } }>(
    '/v1/domains/:domain/verify',
    async (request, reply) => {
      const parsed = verifyDomainSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Validation failed',
          details: parsed.error.flatten(),
        });
      }

      const pool = getPool();
      const domainName = request.params.domain.toLowerCase();

      const result = await pool.query(
        `SELECT * FROM domains WHERE tenant_id = $1 AND domain = $2`,
        [parsed.data.tenant_id, domainName]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Domain not found' });
      }

      const row = result.rows[0];
      const checks = await verifyDomainDns(
        domainName,
        row.dkim_selector,
        row.dkim_public_key
      );

      const allVerified = checks.spf && checks.dkim && checks.dmarc;
      const status = allVerified ? 'verified' : 'pending';

      const updated = await pool.query(
        `UPDATE domains
         SET status = $3,
             spf_verified = $4,
             dkim_verified = $5,
             dmarc_verified = $6,
             verified_at = CASE WHEN $3 = 'verified' THEN NOW() ELSE verified_at END,
             updated_at = NOW()
         WHERE tenant_id = $1 AND domain = $2
         RETURNING *`,
        [
          parsed.data.tenant_id,
          domainName,
          status,
          checks.spf,
          checks.dkim,
          checks.dmarc,
        ]
      );

      return reply.send({
        ...toDomainResponse(updated.rows[0]),
        verification: checks,
      });
    }
  );
}
