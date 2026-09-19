import type { Pool } from 'pg';
import {
  loadConfig,
  resolvePoolId,
  resolveEgressIpFromConfig,
  purposeForQueue,
  type IpPoolId,
  type RiskTier,
  type SendPurpose,
} from '@vmds/shared';

export interface IpPoolRow {
  pool_id: IpPoolId;
  egress_ip: string;
  description: string | null;
  purpose: SendPurpose;
  risk_tier: RiskTier;
  hourly_send_limit: number;
  daily_send_limit: number;
  updated_at: Date;
}

function mapPoolRow(row: Record<string, unknown>): IpPoolRow {
  return {
    pool_id: row.pool_id as IpPoolId,
    egress_ip: row.egress_ip as string,
    description: (row.description as string | null) ?? null,
    purpose: (row.purpose as SendPurpose) ?? 'marketing',
    risk_tier: (row.risk_tier as RiskTier) ?? 'standard',
    hourly_send_limit: Number(row.hourly_send_limit ?? 0),
    daily_send_limit: Number(row.daily_send_limit ?? 0),
    updated_at: new Date(row.updated_at as string),
  };
}

export async function getIpPoolRows(pool: Pool): Promise<IpPoolRow[]> {
  const result = await pool.query(
    `SELECT pool_id, egress_ip, description, purpose, risk_tier,
            hourly_send_limit, daily_send_limit, updated_at
     FROM ip_pools
     ORDER BY purpose, risk_tier, pool_id`
  );
  return result.rows.map((row) => mapPoolRow(row));
}

export async function resolveEgressIpForSend(
  pool: Pool,
  tenantId: string,
  queueType: 'transaction' | 'campaign'
): Promise<{ pool_id: IpPoolId; egress_ip: string }> {
  const config = loadConfig();
  const purpose = purposeForQueue(queueType);

  const dedicated = await pool.query(
    `SELECT egress_ip FROM tenant_egress_assignments
     WHERE tenant_id = $1 AND purpose = $2`,
    [tenantId, purpose]
  );
  if (dedicated.rows[0]?.egress_ip) {
    const scoreRow = await pool.query(
      `SELECT score FROM tenant_reputation WHERE tenant_id = $1`,
      [tenantId]
    );
    const score = scoreRow.rows[0]
      ? Number(scoreRow.rows[0].score)
      : config.REPUTATION_DEFAULT_SCORE;
    return {
      pool_id: resolvePoolId(queueType, null, score),
      egress_ip: dedicated.rows[0].egress_ip as string,
    };
  }

  const policy = await pool.query(`SELECT ip_pool FROM tenant_policies WHERE tenant_id = $1`, [
    tenantId,
  ]);
  const tenantPool = (policy.rows[0]?.ip_pool as string | null | undefined) ?? null;
  const scoreRow = await pool.query(
    `SELECT score FROM tenant_reputation WHERE tenant_id = $1`,
    [tenantId]
  );
  const score = scoreRow.rows[0]
    ? Number(scoreRow.rows[0].score)
    : config.REPUTATION_DEFAULT_SCORE;
  const poolId = resolvePoolId(queueType, tenantPool, score);

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
    purpose: row.purpose,
    risk_tier: row.risk_tier,
    hourly_send_limit: row.hourly_send_limit,
    daily_send_limit: row.daily_send_limit,
    updated_at: row.updated_at.toISOString(),
  };
}
