import type { Pool } from 'pg';

export async function getDkimForSender(
  pool: Pool,
  tenantId: string,
  fromEmail: string
): Promise<{ domainName: string; keySelector: string; privateKey: string } | null> {
  const domain = fromEmail.split('@')[1]?.toLowerCase();
  if (!domain) {
    return null;
  }

  const result = await pool.query(
    `SELECT domain, dkim_selector, dkim_private_key
     FROM domains
     WHERE tenant_id = $1 AND domain = $2 AND status = 'verified'`,
    [tenantId, domain]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    domainName: row.domain,
    keySelector: row.dkim_selector,
    privateKey: row.dkim_private_key,
  };
}
