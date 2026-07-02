import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { extractLinkUrls } from '@vmds/shared';

function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function createTrackingTokens(
  pool: Pool,
  input: {
    tenantId: string;
    messageId: string;
    html?: string;
    opens: boolean;
    clicks: boolean;
  }
): Promise<void> {
  const { tenantId, messageId, html, opens, clicks } = input;

  if (opens) {
    await pool.query(
      `INSERT INTO tracking_tokens (token, tenant_id, message_id, token_type)
       VALUES ($1, $2, $3, 'open')`,
      [generateToken(), tenantId, messageId]
    );
  }

  if (clicks && html) {
    const urls = extractLinkUrls(html);
    for (const url of urls) {
      await pool.query(
        `INSERT INTO tracking_tokens (token, tenant_id, message_id, token_type, target_url)
         VALUES ($1, $2, $3, 'click', $4)`,
        [generateToken(), tenantId, messageId, url]
      );
    }
  }
}

export interface TrackingTokenRow {
  token: string;
  token_type: 'open' | 'click';
  target_url: string | null;
}

export async function getTrackingTokensForMessage(
  pool: Pool,
  messageId: string
): Promise<TrackingTokenRow[]> {
  const result = await pool.query(
    `SELECT token, token_type, target_url
     FROM tracking_tokens
     WHERE message_id = $1`,
    [messageId]
  );
  return result.rows as TrackingTokenRow[];
}

export interface TrackingHitResult {
  messageId: string;
  tenantId: string;
  tokenType: 'open' | 'click';
  targetUrl: string | null;
  hitCount: number;
  isFirstHit: boolean;
  metadata: Record<string, unknown> | null;
  recipient: string | null;
}

export async function recordTrackingHit(
  pool: Pool,
  token: string
): Promise<TrackingHitResult | null> {
  const updated = await pool.query(
    `UPDATE tracking_tokens
     SET hit_count = hit_count + 1,
         first_hit_at = COALESCE(first_hit_at, NOW()),
         last_hit_at = NOW()
     WHERE token = $1
     RETURNING token_type, target_url, hit_count, message_id, tenant_id`,
    [token]
  );

  if (updated.rows.length === 0) {
    return null;
  }

  const row = updated.rows[0];
  const messageResult = await pool.query(
    `SELECT metadata, to_addresses FROM messages WHERE id = $1`,
    [row.message_id]
  );

  if (messageResult.rows.length === 0) {
    return null;
  }

  const msg = messageResult.rows[0];
  const toAddresses = msg.to_addresses as Array<{ email: string }>;
  const recipient = toAddresses[0]?.email ?? null;

  return {
    messageId: row.message_id,
    tenantId: row.tenant_id,
    tokenType: row.token_type,
    targetUrl: row.target_url,
    hitCount: row.hit_count,
    isFirstHit: row.hit_count === 1,
    metadata: msg.metadata,
    recipient,
  };
}
