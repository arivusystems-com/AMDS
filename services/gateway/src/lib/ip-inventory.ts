import type { Pool } from 'pg';
import type { SendPurpose } from '@vmds/shared';

export interface InventoryRow {
  egress_ip: string;
  state: string;
  purpose: string | null;
  risk_tier: string | null;
  attached: boolean;
  ptr_configured: boolean;
  notes: string | null;
  updated_at: Date;
}

export async function listInventory(pool: Pool): Promise<InventoryRow[]> {
  const result = await pool.query(
    `SELECT egress_ip, state, purpose, risk_tier, attached, ptr_configured, notes, updated_at
     FROM ip_inventory
     ORDER BY purpose NULLS LAST, risk_tier NULLS LAST, egress_ip`
  );
  return result.rows.map((row) => ({
    egress_ip: row.egress_ip as string,
    state: row.state as string,
    purpose: (row.purpose as string | null) ?? null,
    risk_tier: (row.risk_tier as string | null) ?? null,
    attached: Boolean(row.attached),
    ptr_configured: Boolean(row.ptr_configured),
    notes: (row.notes as string | null) ?? null,
    updated_at: new Date(row.updated_at as string),
  }));
}

export async function upsertInventoryIp(
  pool: Pool,
  input: {
    egress_ip: string;
    purpose?: string;
    risk_tier?: string;
    attached?: boolean;
    ptr_configured?: boolean;
    notes?: string;
    state?: string;
  }
): Promise<InventoryRow> {
  const result = await pool.query(
    `INSERT INTO ip_inventory (egress_ip, state, purpose, risk_tier, attached, ptr_configured, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (egress_ip) DO UPDATE SET
       state = EXCLUDED.state,
       purpose = COALESCE(EXCLUDED.purpose, ip_inventory.purpose),
       risk_tier = COALESCE(EXCLUDED.risk_tier, ip_inventory.risk_tier),
       attached = EXCLUDED.attached,
       ptr_configured = EXCLUDED.ptr_configured,
       notes = COALESCE(EXCLUDED.notes, ip_inventory.notes),
       updated_at = NOW()
     RETURNING *`,
    [
      input.egress_ip,
      input.state ?? 'free',
      input.purpose ?? null,
      input.risk_tier ?? null,
      input.attached ?? true,
      input.ptr_configured ?? false,
      input.notes ?? null,
    ]
  );
  const row = result.rows[0];
  return {
    egress_ip: row.egress_ip as string,
    state: row.state as string,
    purpose: (row.purpose as string | null) ?? null,
    risk_tier: (row.risk_tier as string | null) ?? null,
    attached: Boolean(row.attached),
    ptr_configured: Boolean(row.ptr_configured),
    notes: (row.notes as string | null) ?? null,
    updated_at: new Date(row.updated_at as string),
  };
}

export async function listTenantAssignments(pool: Pool, tenantId?: string) {
  const result = tenantId
    ? await pool.query(
        `SELECT tenant_id, purpose, egress_ip, source, assigned_at, updated_at
         FROM tenant_egress_assignments WHERE tenant_id = $1
         ORDER BY purpose`,
        [tenantId]
      )
    : await pool.query(
        `SELECT tenant_id, purpose, egress_ip, source, assigned_at, updated_at
         FROM tenant_egress_assignments
         ORDER BY tenant_id, purpose`
      );

  return result.rows.map((row) => ({
    tenant_id: row.tenant_id as string,
    purpose: row.purpose as SendPurpose,
    egress_ip: row.egress_ip as string,
    source: row.source as string,
    assigned_at: new Date(row.assigned_at as string).toISOString(),
    updated_at: new Date(row.updated_at as string).toISOString(),
  }));
}

export async function assignDedicatedIp(
  pool: Pool,
  tenantId: string,
  purpose: SendPurpose,
  preferredIp?: string
): Promise<{ tenant_id: string; purpose: SendPurpose; egress_ip: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let egressIp = preferredIp;
    if (egressIp) {
      const existing = await client.query(
        `SELECT egress_ip, state FROM ip_inventory WHERE egress_ip = $1 FOR UPDATE`,
        [egressIp]
      );
      if (existing.rows.length === 0) {
        throw new Error('IP not found in inventory');
      }
      if (existing.rows[0].state !== 'free' && existing.rows[0].state !== 'warming') {
        throw new Error(`IP state is ${existing.rows[0].state}, expected free`);
      }
    } else {
      const free = await client.query(
        `SELECT egress_ip FROM ip_inventory
         WHERE state = 'free' AND attached = true
           AND (purpose IS NULL OR purpose = $1)
         ORDER BY egress_ip
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [purpose]
      );
      if (free.rows.length === 0) {
        throw new Error('No free attached IPs in inventory');
      }
      egressIp = free.rows[0].egress_ip as string;
    }

    await client.query(
      `UPDATE ip_inventory SET state = 'assigned', purpose = $2, updated_at = NOW()
       WHERE egress_ip = $1`,
      [egressIp, purpose]
    );

    await client.query(
      `INSERT INTO tenant_egress_assignments (tenant_id, purpose, egress_ip, source)
       VALUES ($1, $2, $3, 'dedicated')
       ON CONFLICT (tenant_id, purpose) DO UPDATE SET
         egress_ip = EXCLUDED.egress_ip,
         source = 'dedicated',
         updated_at = NOW()`,
      [tenantId, purpose, egressIp]
    );

    await client.query('COMMIT');
    return { tenant_id: tenantId, purpose, egress_ip: egressIp! };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseDedicatedIp(
  pool: Pool,
  tenantId: string,
  purpose: SendPurpose
): Promise<{ released: boolean; egress_ip?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT egress_ip FROM tenant_egress_assignments
       WHERE tenant_id = $1 AND purpose = $2
       FOR UPDATE`,
      [tenantId, purpose]
    );
    if (existing.rows.length === 0) {
      await client.query('COMMIT');
      return { released: false };
    }
    const egressIp = existing.rows[0].egress_ip as string;
    await client.query(
      `DELETE FROM tenant_egress_assignments WHERE tenant_id = $1 AND purpose = $2`,
      [tenantId, purpose]
    );
    await client.query(
      `UPDATE ip_inventory SET state = 'free', updated_at = NOW()
       WHERE egress_ip = $1 AND state = 'assigned'`,
      [egressIp]
    );
    await client.query('COMMIT');
    return { released: true, egress_ip: egressIp };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getProviderHourlyLimit(pool: Pool, providerKey: string): Promise<number> {
  const result = await pool.query(
    `SELECT hourly_send_limit FROM provider_rate_limits WHERE provider_key = $1`,
    [providerKey]
  );
  return Number(result.rows[0]?.hourly_send_limit ?? 0);
}
