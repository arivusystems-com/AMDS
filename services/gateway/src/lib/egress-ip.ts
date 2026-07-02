import type { Pool } from 'pg';
import {
  loadConfig,
  egressIpDailyCap,
  egressWarmupStage,
} from '@vmds/shared';
import { getRedis } from './redis.js';

function utcDayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

export interface EgressCapResult {
  allowed: boolean;
  ip_address: string;
  daily_cap: number | null;
  sent_today: number;
  warmup_stage: string;
  retry_after_ms: number;
}

export async function ensureEgressIpState(
  pool: Pool,
  ipAddress: string
): Promise<{ first_send_at: Date | null }> {
  const result = await pool.query(
    `INSERT INTO egress_ip_state (ip_address)
     VALUES ($1)
     ON CONFLICT (ip_address) DO NOTHING
     RETURNING first_send_at`,
    [ipAddress]
  );

  if (result.rows.length > 0) {
    return { first_send_at: result.rows[0].first_send_at ?? null };
  }

  const existing = await pool.query(
    `SELECT first_send_at FROM egress_ip_state WHERE ip_address = $1`,
    [ipAddress]
  );
  return {
    first_send_at: existing.rows[0]?.first_send_at
      ? new Date(existing.rows[0].first_send_at)
      : null,
  };
}

async function readDailySent(ipAddress: string): Promise<number> {
  const redis = getRedis();
  const value = await redis.get(`egress:${ipAddress}:daily:${utcDayKey()}`);
  return value ? Number.parseInt(value, 10) : 0;
}

export async function checkEgressCap(pool: Pool, ipAddress: string): Promise<EgressCapResult> {
  const state = await ensureEgressIpState(pool, ipAddress);
  const sentToday = await readDailySent(ipAddress);

  if (!state.first_send_at) {
    return {
      allowed: true,
      ip_address: ipAddress,
      daily_cap: null,
      sent_today: sentToday,
      warmup_stage: 'not_started',
      retry_after_ms: 0,
    };
  }

  const daysSince =
    (Date.now() - state.first_send_at.getTime()) / 86_400_000;
  const dailyCap = egressIpDailyCap(daysSince);
  const warmupStage = egressWarmupStage(daysSince);

  if (dailyCap === null || sentToday < dailyCap) {
    return {
      allowed: true,
      ip_address: ipAddress,
      daily_cap: dailyCap,
      sent_today: sentToday,
      warmup_stage: warmupStage,
      retry_after_ms: 0,
    };
  }

  return {
    allowed: false,
    ip_address: ipAddress,
    daily_cap: dailyCap,
    sent_today: sentToday,
    warmup_stage: warmupStage,
    retry_after_ms: 3600_000,
  };
}

export async function recordEgressSend(pool: Pool, ipAddress: string): Promise<void> {
  await ensureEgressIpState(pool, ipAddress);

  await pool.query(
    `UPDATE egress_ip_state
     SET first_send_at = COALESCE(first_send_at, NOW()),
         updated_at = NOW()
     WHERE ip_address = $1`,
    [ipAddress]
  );

  const redis = getRedis();
  const key = `egress:${ipAddress}:daily:${utcDayKey()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 86_400 * 2);
  }
}

export async function getEgressIpStatus(pool: Pool, ipAddress: string) {
  const config = loadConfig();
  const state = await ensureEgressIpState(pool, ipAddress);
  const sentToday = await readDailySent(ipAddress);
  const daysSince = state.first_send_at
    ? (Date.now() - state.first_send_at.getTime()) / 86_400_000
    : -1;

  return {
    ip_address: ipAddress,
    configured_ip: config.EGRESS_IP,
    first_send_at: state.first_send_at?.toISOString() ?? null,
    days_since_first_send: daysSince >= 0 ? Math.floor(daysSince) : null,
    warmup_stage: state.first_send_at ? egressWarmupStage(daysSince) : 'not_started',
    daily_cap: state.first_send_at ? egressIpDailyCap(daysSince) : null,
    sent_today: sentToday,
  };
}
