import type { Pool } from 'pg';
import { injectTrackingHtml, loadConfig } from '@vmds/shared';

interface TrackingTokenRow {
  token: string;
  token_type: 'open' | 'click';
  target_url: string | null;
}

export async function applyTrackingToHtml(
  pool: Pool,
  messageId: string,
  html: string | undefined
): Promise<string | undefined> {
  if (!html) {
    return html;
  }

  const result = await pool.query(
    `SELECT token, token_type, target_url
     FROM tracking_tokens
     WHERE message_id = $1`,
    [messageId]
  );

  const tokens = result.rows as TrackingTokenRow[];
  if (tokens.length === 0) {
    return html;
  }

  const config = loadConfig();
  let openToken: string | null = null;
  const clickTokens: Record<string, string> = {};

  for (const row of tokens) {
    if (row.token_type === 'open') {
      openToken = row.token;
    } else if (row.token_type === 'click' && row.target_url) {
      clickTokens[row.target_url] = row.token;
    }
  }

  return injectTrackingHtml(html, config.TRACKING_BASE_URL, openToken, clickTokens);
}
