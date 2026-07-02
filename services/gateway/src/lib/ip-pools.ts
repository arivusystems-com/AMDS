import type { Pool } from 'pg';
import {
  loadConfig,
  resolvePoolId,
  resolveEgressIpFromConfig,
  type IpPoolId,
} from '@vmds/shared';

export interface IpPoolRow {
  pool_id: IpPoolId;
  egress_ip: string;
  description: string | null;
  updated_at: Date;
}

export async function getIpPoolRows(pool: Pool): Promise<IpPoolRow[]> {
  const result = await pool.query(
    `SELECT pool_id, egress_ip, description, updated_at FROM ip_pools ORDER BY pool_id`
  );
  return result.rows.map((row) => ({
    pool_id: row.pool_id as IpPoolId,
    egress_ip: row.egress_ip as string,
    description: (row.description as string | null) ?? null,
    updated_at: new Date(row.updated_at as string),
  }));
}

export async function resolveEgressIpForSend(
  pool: Pool,
  tenantId: string,
  queueType: 'transaction' | 'campaign'
): Promise<{ pool_id: IpPoolId; egress_ip: string }> {
  const config = loadConfig();
  const policy = await pool.query(`SELECT ip_pool FROM tenant_policies WHERE tenant_id = $1`, [
    tenantId,
  ]);
  const tenantPool = (policy.rows[0]?.ip_pool as IpPoolId | null | undefined) ?? null;
  const poolId = resolvePoolId(queueType, tenantPool);

  const poolRow = await pool.query(`SELECT egress_ip FROM ip_pools WHERE pool_id = $1`, [poolId]);
  const egressIp =
    (poolRow.rows[0]?.egress_ip as string | undefined) ??
    resolveEgressIpFromConfig(poolId, config);

  return { pool_id: poolId, egress_ip: egressIp };
}

export function formatIpPoolResponse(row: IpPoolRow) {
  return {
    pool_id: row.pool_id,
    egress_ip: row.egress_ip,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
  };
}
