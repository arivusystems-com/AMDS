import type { Pool } from 'pg';
import type { TenantPolicyInput } from '@vmds/shared';

export interface TenantPolicyRow {
  tenant_id: string;
  status: 'active' | 'suspended';
  monthly_credits: number;
  credits_remaining: number;
  credits_reserved: number;
  daily_send_limit: number;
  max_hourly_rate: number;
  burst_rate_per_min: number;
  max_campaign_size: number;
  warmup_enabled: boolean;
  reputation_enabled: boolean;
  ip_pool: 'transaction' | 'marketing' | null;
  first_send_at: Date | null;
  synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapPolicyRow(row: Record<string, unknown>): TenantPolicyRow {
  return {
    tenant_id: row.tenant_id as string,
    status: row.status as 'active' | 'suspended',
    monthly_credits: Number(row.monthly_credits),
    credits_remaining: Number(row.credits_remaining),
    credits_reserved: Number(row.credits_reserved),
    daily_send_limit: Number(row.daily_send_limit),
    max_hourly_rate: Number(row.max_hourly_rate),
    burst_rate_per_min: Number(row.burst_rate_per_min),
    max_campaign_size: Number(row.max_campaign_size),
    warmup_enabled: Boolean(row.warmup_enabled),
    reputation_enabled: Boolean(row.reputation_enabled),
    ip_pool: (row.ip_pool as 'transaction' | 'marketing' | null) ?? null,
    first_send_at: row.first_send_at ? new Date(row.first_send_at as string) : null,
    synced_at: new Date(row.synced_at as string),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

export function formatPolicyResponse(row: TenantPolicyRow) {
  return {
    tenant_id: row.tenant_id,
    status: row.status,
    monthly_credits: row.monthly_credits,
    credits_remaining: row.credits_remaining,
    credits_reserved: row.credits_reserved,
    daily_send_limit: row.daily_send_limit,
    max_hourly_rate: row.max_hourly_rate,
    burst_rate_per_min: row.burst_rate_per_min,
    max_campaign_size: row.max_campaign_size,
    warmup_enabled: row.warmup_enabled,
    reputation_enabled: row.reputation_enabled,
    ip_pool: row.ip_pool,
    first_send_at: row.first_send_at?.toISOString() ?? null,
    synced_at: row.synced_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getTenantPolicy(
  pool: Pool,
  tenantId: string
): Promise<TenantPolicyRow | null> {
  const result = await pool.query(`SELECT * FROM tenant_policies WHERE tenant_id = $1`, [tenantId]);
  if (result.rows.length === 0) {
    return null;
  }
  return mapPolicyRow(result.rows[0]);
}

export async function upsertTenantPolicy(
  pool: Pool,
  tenantId: string,
  input: TenantPolicyInput
): Promise<TenantPolicyRow> {
  const result = await pool.query(
    `INSERT INTO tenant_policies (
       tenant_id, status, monthly_credits, credits_remaining,
       daily_send_limit, max_hourly_rate, burst_rate_per_min, max_campaign_size,
       warmup_enabled, reputation_enabled, ip_pool, synced_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       status = EXCLUDED.status,
       monthly_credits = EXCLUDED.monthly_credits,
       credits_remaining = EXCLUDED.credits_remaining,
       daily_send_limit = EXCLUDED.daily_send_limit,
       max_hourly_rate = EXCLUDED.max_hourly_rate,
       burst_rate_per_min = EXCLUDED.burst_rate_per_min,
       max_campaign_size = EXCLUDED.max_campaign_size,
       warmup_enabled = EXCLUDED.warmup_enabled,
       reputation_enabled = EXCLUDED.reputation_enabled,
       ip_pool = EXCLUDED.ip_pool,
       synced_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      input.status,
      input.monthly_credits,
      input.credits_remaining,
      input.daily_send_limit,
      input.max_hourly_rate,
      input.burst_rate_per_min,
      input.max_campaign_size,
      input.warmup_enabled,
      input.reputation_enabled,
      input.ip_pool ?? null,
    ]
  );
  return mapPolicyRow(result.rows[0]);
}

export async function setTenantStatus(
  pool: Pool,
  tenantId: string,
  status: 'active' | 'suspended'
): Promise<TenantPolicyRow | null> {
  const result = await pool.query(
    `UPDATE tenant_policies
     SET status = $2, synced_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [tenantId, status]
  );
  if (result.rows.length === 0) {
    return null;
  }
  return mapPolicyRow(result.rows[0]);
}

export async function allocateCredits(
  pool: Pool,
  tenantId: string,
  amount: number,
  reason?: string
): Promise<TenantPolicyRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const current = await client.query(`SELECT * FROM tenant_policies WHERE tenant_id = $1 FOR UPDATE`, [
      tenantId,
    ]);
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const updated = await client.query(
      `UPDATE tenant_policies
       SET credits_remaining = credits_remaining + $2,
           monthly_credits = monthly_credits + $2,
           synced_at = NOW(),
           updated_at = NOW()
       WHERE tenant_id = $1
       RETURNING *`,
      [tenantId, amount]
    );

    const row = mapPolicyRow(updated.rows[0]);
    await client.query(
      `INSERT INTO credit_ledger (tenant_id, action, amount, balance_after, reserved_after, detail)
       VALUES ($1, 'allocate', $2, $3, $4, $5)`,
      [
        tenantId,
        amount,
        row.credits_remaining,
        row.credits_reserved,
        reason ? JSON.stringify({ reason }) : null,
      ]
    );

    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
