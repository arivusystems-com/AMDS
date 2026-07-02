import type { Pool } from 'pg';
import { dispatchTenantWebhook } from './tenant-webhooks.js';

export async function consumeCredit(
  pool: Pool,
  tenantId: string,
  messageId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reservation = await client.query(
      `SELECT amount FROM credit_reservations
       WHERE message_id = $1 AND status = 'reserved'
       FOR UPDATE`,
      [messageId]
    );
    if (reservation.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const amount = Number(reservation.rows[0].amount);

    const updated = await client.query(
      `UPDATE tenant_policies
       SET credits_reserved = credits_reserved - $2,
           first_send_at = COALESCE(first_send_at, NOW()),
           updated_at = NOW()
       WHERE tenant_id = $1
       RETURNING credits_remaining, credits_reserved`,
      [tenantId, amount]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE credit_reservations SET status = 'consumed', updated_at = NOW() WHERE message_id = $1`,
      [messageId]
    );

    const balanceAfter = Number(updated.rows[0].credits_remaining);
    const reservedAfter = Number(updated.rows[0].credits_reserved);

    await client.query(
      `INSERT INTO credit_ledger (tenant_id, message_id, action, amount, balance_after, reserved_after)
       VALUES ($1, $2, 'consume', $3, $4, $5)`,
      [tenantId, messageId, amount, balanceAfter, reservedAfter]
    );

    await client.query('COMMIT');

    try {
      await dispatchTenantWebhook({
        event_type: 'credit.consumed',
        tenant_id: tenantId,
        message_id: messageId,
        credit: { amount, balance_after: balanceAfter, reserved_after: reservedAfter },
      });
    } catch {
      // consumption persisted
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseCredit(
  pool: Pool,
  tenantId: string,
  messageId: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reservation = await client.query(
      `SELECT amount FROM credit_reservations
       WHERE message_id = $1 AND status = 'reserved'
       FOR UPDATE`,
      [messageId]
    );
    if (reservation.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    const amount = Number(reservation.rows[0].amount);

    const updated = await client.query(
      `UPDATE tenant_policies
       SET credits_remaining = credits_remaining + $2,
           credits_reserved = credits_reserved - $2,
           updated_at = NOW()
       WHERE tenant_id = $1
       RETURNING credits_remaining, credits_reserved`,
      [tenantId, amount]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE credit_reservations SET status = 'released', updated_at = NOW() WHERE message_id = $1`,
      [messageId]
    );

    const balanceAfter = Number(updated.rows[0].credits_remaining);
    const reservedAfter = Number(updated.rows[0].credits_reserved);

    await client.query(
      `INSERT INTO credit_ledger (tenant_id, message_id, action, amount, balance_after, reserved_after)
       VALUES ($1, $2, 'release', $3, $4, $5)`,
      [tenantId, messageId, amount, balanceAfter, reservedAfter]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
