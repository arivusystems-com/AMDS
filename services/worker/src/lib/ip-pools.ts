import type { Pool } from 'pg';
import {
  loadConfig,
  resolvePoolId,
  resolveEgressIpFromConfig,
  purposeForQueue,
  isBindableIp,
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

export interface EgressResolution {
  pool_id: IpPoolId;
  egress_ip: string;
  purpose: SendPurpose;
  risk_tier: RiskTier;
  source: 'dedicated' | 'shared_tier' | 'override';
  reputation_score: number;
  hourly_send_limit: number;
  daily_send_limit: number;
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

async function getTenantScore(pool: Pool, tenantId: string): Promise<number> {
  const config = loadConfig();
  const result = await pool.query(
    `SELECT score FROM tenant_reputation WHERE tenant_id = $1`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    return config.REPUTATION_DEFAULT_SCORE;
  }
  return Number(result.rows[0].score);
}

async function getDedicatedEgress(
  pool: Pool,
  tenantId: string,
  purpose: SendPurpose
): Promise<string | null> {
  const result = await pool.query(
    `SELECT egress_ip FROM tenant_egress_assignments
     WHERE tenant_id = $1 AND purpose = $2`,
    [tenantId, purpose]
  );
  return (result.rows[0]?.egress_ip as string | undefined) ?? null;
}

export async function resolveEgressIpForSend(
  pool: Pool,
  tenantId: string,
  queueType: 'transaction' | 'campaign'
): Promise<EgressResolution> {
  const config = loadConfig();
  const purpose = purposeForQueue(queueType);

  const dedicated = await getDedicatedEgress(pool, tenantId, purpose);
  if (dedicated) {
    const score = await getTenantScore(pool, tenantId);
    const poolId = resolvePoolId(queueType, null, score);
    const poolRow = await pool.query(
      `SELECT * FROM ip_pools WHERE pool_id = $1`,
      [poolId]
    );
    const mapped = poolRow.rows[0] ? mapPoolRow(poolRow.rows[0]) : null;
    return {
      pool_id: poolId,
      egress_ip: dedicated,
      purpose,
      risk_tier: mapped?.risk_tier ?? 'standard',
      source: 'dedicated',
      reputation_score: score,
      hourly_send_limit: mapped?.hourly_send_limit ?? 0,
      daily_send_limit: mapped?.daily_send_limit ?? 0,
    };
  }

  const policy = await pool.query(`SELECT ip_pool FROM tenant_policies WHERE tenant_id = $1`, [
    tenantId,
  ]);
  const tenantPool = (policy.rows[0]?.ip_pool as string | null | undefined) ?? null;
  const score = await getTenantScore(pool, tenantId);
  const poolId = resolvePoolId(queueType, tenantPool, score);

  const poolRow = await pool.query(`SELECT * FROM ip_pools WHERE pool_id = $1`, [poolId]);
  const mapped = poolRow.rows[0] ? mapPoolRow(poolRow.rows[0]) : null;
  const egressIp =
    mapped?.egress_ip ?? resolveEgressIpFromConfig(poolId, config);

  return {
    pool_id: poolId,
    egress_ip: egressIp,
    purpose,
    risk_tier: mapped?.risk_tier ?? (purpose === 'transaction' ? 'healthy' : 'standard'),
    source: tenantPool ? 'override' : 'shared_tier',
    reputation_score: score,
    hourly_send_limit: mapped?.hourly_send_limit ?? 0,
    daily_send_limit: mapped?.daily_send_limit ?? 0,
  };
}

export function assertEgressBindable(egressIp: string, required: boolean): void {
  if (!required) {
    return;
  }
  if (!isBindableIp(egressIp)) {
    throw new Error(
      `Egress IP "${egressIp}" is not bindable / not attached — infra bind failure`
    );
  }
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
