import type { Pool } from 'pg';

export async function isSuppressed(
  pool: Pool,
  tenantId: string,
  email: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM suppressions WHERE tenant_id = $1 AND email = $2`,
    [tenantId, email.toLowerCase()]
  );
  return result.rows.length > 0;
}

export async function getVerifiedDomain(
  pool: Pool,
  tenantId: string,
  domain: string
): Promise<{ dkim_selector: string; dkim_private_key: string } | null> {
  const result = await pool.query(
    `SELECT dkim_selector, dkim_private_key
     FROM domains
     WHERE tenant_id = $1 AND domain = $2 AND status = 'verified'`,
    [tenantId, domain.toLowerCase()]
  );
  return result.rows[0] ?? null;
}
