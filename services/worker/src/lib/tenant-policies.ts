import type { Pool } from 'pg';

export async function getTenantPolicy(
  pool: Pool,
  tenantId: string
): Promise<{ reputation_enabled: boolean } | null> {
  const result = await pool.query(
    `SELECT reputation_enabled FROM tenant_policies WHERE tenant_id = $1`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return { reputation_enabled: Boolean(result.rows[0].reputation_enabled) };
}
