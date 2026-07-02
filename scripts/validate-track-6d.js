#!/usr/bin/env node
/**
 * Track 6 Phase 4 validation — campaign health & reputation guidance.
 * Usage: npm run validate:track-6d
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const MAILPIT_URL = process.env.MAILPIT_API_URL || 'http://localhost:8025';
const TENANT = `track6d-${Date.now()}`;
const CAMPAIGN_ID = `health-${Date.now()}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 45_000;

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(method, urlPath, { body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (auth && API_KEY) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }

  const response = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  let json = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  return { status: response.status, json, headers: response.headers };
}

async function pollMessage(messageId, predicate, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, json } = await request('GET', `/v1/messages/${messageId}`);
    if (status === 200 && predicate(json)) {
      return json;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timed out waiting for message ${messageId}`);
}

async function getMailpitHtml(subject) {
  const search = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(subject)}`
  );
  if (!search.ok) return null;
  const { messages } = await search.json();
  if (!messages?.length) return null;

  const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`);
  if (!detail.ok) return null;
  const msg = await detail.json();
  return msg.HTML ?? msg.Text ?? '';
}

function extractTrackingUrls(html) {
  const openMatch = html.match(/\/t\/([A-Za-z0-9_-]+)\.png/);
  const clickMatch = html.match(/\/c\/([A-Za-z0-9_-]+)/);
  return {
    openToken: openMatch?.[1] ?? null,
    clickToken: clickMatch?.[1] ?? null,
  };
}

async function main() {
  console.log(`Track 6d validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  const policy = {
    status: 'active',
    monthly_credits: 10_000,
    credits_remaining: 10_000,
    daily_send_limit: 10_000,
    max_hourly_rate: 5000,
    burst_rate_per_min: 500,
    max_campaign_size: 500,
    warmup_enabled: false,
    reputation_enabled: true,
  };

  await request('PUT', `/v1/tenants/${TENANT}/policy`, { body: policy });
  pass('PUT policy');

  const subjectGood = `Track6d-good-${TENANT}`;
  const subjectBounce = `Track6d-bounce-${TENANT}`;
  const subjectComplaint = `Track6d-complaint-${TENANT}`;
  const landingUrl = 'https://example.com/health-test';

  const batch = await request('POST', `/v1/campaigns/${CAMPAIGN_ID}/messages`, {
    body: {
      tenant_id: TENANT,
      from: { email: 'marketing@localhost.test' },
      tracking: { opens: true, clicks: true },
      messages: [
        {
          idempotency_key: `${TENANT}-good`,
          to: [{ email: 'good@example.com' }],
          subject: subjectGood,
          content: {
            html: `<html><body><p>Good</p><a href="${landingUrl}">Click</a></body></html>`,
            text: 'Good',
          },
        },
        {
          idempotency_key: `${TENANT}-bounce`,
          to: [{ email: 'bounce@example.com' }],
          subject: subjectBounce,
          content: { text: 'Bounce test' },
        },
        {
          idempotency_key: `${TENANT}-complaint`,
          to: [{ email: 'complaint@example.com' }],
          subject: subjectComplaint,
          content: { text: 'Complaint test' },
        },
      ],
    },
  });

  if (batch.status !== 202 || batch.json?.accepted !== 3) {
    fail('Campaign batch', `status=${batch.status} accepted=${batch.json?.accepted}`);
    process.exit(1);
  }
  pass('Campaign batch accepted', '3 messages');

  const messageIds = batch.json.messages.map((m) => m.message_id);
  for (const id of messageIds) {
    await pollMessage(id, (m) => m.status === 'delivered');
  }
  pass('All campaign messages delivered');

  const html = await getMailpitHtml(subjectGood);
  const { openToken, clickToken } = extractTrackingUrls(html ?? '');
  if (openToken && clickToken) {
    await request('GET', `/t/${openToken}.png`, { auth: false });
    await request('GET', `/c/${clickToken}`, { auth: false });
    pass('Open and click tracked');
  } else {
    fail('Tracking tokens', 'could not parse Mailpit HTML');
  }

  await request('POST', '/v1/admin/simulate-bounce', {
    body: {
      tenant_id: TENANT,
      message_id: messageIds[1],
      bounce_type: 'hard',
    },
  });
  pass('Hard bounce simulated');

  await request('POST', '/v1/admin/simulate-complaint', {
    body: {
      tenant_id: TENANT,
      message_id: messageIds[2],
    },
  });
  pass('Complaint simulated');

  await new Promise((r) => setTimeout(r, 500));

  const health = await request(
    'GET',
    `/v1/campaigns/${CAMPAIGN_ID}/health?tenant_id=${TENANT}`
  );
  if (
    health.status === 200 &&
    health.json?.score >= 0 &&
    health.json?.score <= 100 &&
    health.json?.metrics?.delivered >= 1 &&
    health.json?.metrics?.hardBounced >= 1 &&
    health.json?.metrics?.complaints >= 1 &&
    health.json?.factors?.length > 0
  ) {
    pass('Campaign health', `score=${health.json.score}`);
  } else {
    fail(
      'Campaign health',
      `status=${health.status} score=${health.json?.score} metrics=${JSON.stringify(health.json?.metrics)}`
    );
  }

  const tenantRep = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (
    health.status === 200 &&
    tenantRep.status === 200 &&
    typeof health.json?.score === 'number' &&
    typeof tenantRep.json?.score === 'number'
  ) {
    pass(
      'Campaign health independent of tenant reputation',
      `campaign=${health.json.score} tenant=${tenantRep.json.score}`
    );
  } else {
    fail('Campaign vs tenant reputation', 'missing scores');
  }

  const guidance = await request('GET', `/v1/tenants/${TENANT}/reputation/guidance`);
  if (
    guidance.status === 200 &&
    guidance.json?.reasons?.length >= 5 &&
    guidance.json?.recommendations?.length >= 1 &&
    guidance.json?.reasons.some((r) => r.status === 'failed' || r.status === 'warning')
  ) {
    pass(
      'Reputation guidance',
      `${guidance.json.reasons.length} reasons, ${guidance.json.recommendations.length} tips`
    );
  } else {
    fail(
      'Reputation guidance',
      `status=${guidance.status} reasons=${guidance.json?.reasons?.length}`
    );
  }

  const analytics = await request(
    'GET',
    `/v1/analytics/summary?tenant_id=${TENANT}&campaign_id=${CAMPAIGN_ID}`
  );
  if (
    analytics.status === 200 &&
    analytics.json?.reputation?.score >= 0 &&
    analytics.json?.campaign_health?.score >= 0 &&
    analytics.json?.counts?.complaints >= 1 &&
    analytics.json?.rates?.hard_bounce_rate > 0
  ) {
    pass(
      'Analytics summary extended',
      `rep=${analytics.json.reputation.score} health=${analytics.json.campaign_health.score}`
    );
  } else {
    fail(
      'Analytics summary extended',
      `status=${analytics.status} rep=${analytics.json?.reputation?.score}`
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6d (AMDS Phase 4) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6d — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
