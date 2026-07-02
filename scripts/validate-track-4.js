#!/usr/bin/env node
/**
 * Track 4 validation — run while gateway + worker are up.
 * Usage: npm run validate:track-4
 *
 * Set LITEDESK_WEBHOOK_URL=http://127.0.0.1:3997/api/internal/webhooks/amds on gateway
 * or rely on the mock server started by this script (gateway must pick up env before start).
 */

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const MAILPIT_URL = process.env.MAILPIT_API_URL || 'http://localhost:8025';
const TENANT = `track4-${Date.now()}`;
const CAMPAIGN_ID = `camp-${Date.now()}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 45_000;

const results = [];
const webhookEvents = [];
let mockServer = null;

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

function startWebhookMock() {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          webhookEvents.push(payload);
        } catch {
          // ignore parse errors
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    mockServer.listen(3997, '127.0.0.1', () => resolve());
  });
}

async function stopWebhookMock() {
  if (!mockServer) return;
  await new Promise((resolve) => mockServer.close(resolve));
  mockServer = null;
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

async function finish(exitCode) {
  await stopWebhookMock();
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 4 (AMDS local) — PASSED');
  } else {
    console.log(`Track 4 (AMDS local) — FAILED (${failed.length} checks)`);
  }
  process.exit(exitCode);
}

async function main() {
  console.log(`Track 4 validation → ${BASE_URL}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY is not set');
    await finish(1);
    return;
  }

  await startWebhookMock();

  const subject1 = `Track4-A-${TENANT}`;
  const subject2 = `Track4-B-${TENANT}`;
  const landingUrl = 'https://example.com/promo';

  const batch = await request('POST', `/v1/campaigns/${CAMPAIGN_ID}/messages`, {
    body: {
      tenant_id: TENANT,
      from: { email: 'marketing@localhost.test', name: 'Track 4' },
      tracking: { opens: true, clicks: true },
      metadata: { litedesk_module: 'marketing', litedesk_entity_id: CAMPAIGN_ID },
      messages: [
        {
          idempotency_key: `${TENANT}-1`,
          to: [{ email: 'user1@example.com', name: 'User One' }],
          subject: subject1,
          content: {
            html: `<html><body><p>Hello</p><a href="${landingUrl}">Click here</a></body></html>`,
            text: 'Hello',
          },
        },
        {
          idempotency_key: `${TENANT}-2`,
          to: [{ email: 'user2@example.com', name: 'User Two' }],
          subject: subject2,
          content: {
            html: `<html><body><p>Second</p><a href="${landingUrl}">Offer</a></body></html>`,
            text: 'Second',
          },
        },
      ],
    },
  });

  if (batch.status === 202 && batch.json?.accepted === 2) {
    pass('POST /v1/campaigns/:id/messages', `accepted=${batch.json.accepted}`);
  } else {
    fail('POST /v1/campaigns/:id/messages', `status=${batch.status} body=${JSON.stringify(batch.json)}`);
    await finish(1);
    return;
  }

  const messageIds = batch.json.messages.map((m) => m.message_id);
  const primaryId = messageIds[0];

  for (const id of messageIds) {
    const msg = await pollMessage(id, (m) => m.status === 'delivered');
    if (msg.queue === 'campaign') {
      pass(`Campaign delivery ${id.slice(0, 8)}`, 'delivered');
    } else {
      fail(`Campaign delivery ${id.slice(0, 8)}`, `queue=${msg.queue}`);
    }
  }

  const html = await getMailpitHtml(subject1);
  if (html && html.includes('/t/') && html.includes('/c/')) {
    pass('Tracking injection in HTML', 'pixel + click wrap');
  } else {
    fail('Tracking injection in HTML', 'missing tracking URLs in Mailpit message');
  }

  const { openToken, clickToken } = extractTrackingUrls(html ?? '');
  if (!openToken || !clickToken) {
    fail('Extract tracking tokens', 'could not parse Mailpit HTML');
    await finish(1);
    return;
  }

  const pixel = await request('GET', `/t/${openToken}.png`, { auth: false });
  if (pixel.status === 200) {
    pass('GET /t/:token.png', 'open pixel');
  } else {
    fail('GET /t/:token.png', `status=${pixel.status}`);
  }

  const click = await request('GET', `/c/${clickToken}`, { auth: false });
  if (click.status === 302 && click.headers.get('location') === landingUrl) {
    pass('GET /c/:token', `redirect → ${landingUrl}`);
  } else {
    fail('GET /c/:token', `status=${click.status} location=${click.headers.get('location')}`);
  }

  const msgDetail = await request('GET', `/v1/messages/${primaryId}`);
  const eventTypes = (msgDetail.json?.events ?? []).map((e) => e.event_type);
  if (eventTypes.includes('opened') && eventTypes.includes('clicked')) {
    pass('Message events opened/clicked');
  } else {
    fail('Message events opened/clicked', eventTypes.join(', '));
  }

  const analytics = await request(
    'GET',
    `/v1/analytics/summary?tenant_id=${encodeURIComponent(TENANT)}&campaign_id=${encodeURIComponent(CAMPAIGN_ID)}`
  );
  if (
    analytics.status === 200 &&
    analytics.json?.counts?.delivered >= 2 &&
    analytics.json?.counts?.unique_opens >= 1 &&
    analytics.json?.counts?.unique_clicks >= 1
  ) {
    pass(
      'GET /v1/analytics/summary',
      `delivered=${analytics.json.counts.delivered} opens=${analytics.json.counts.unique_opens}`
    );
  } else {
    fail('GET /v1/analytics/summary', JSON.stringify(analytics.json));
  }

  const dup = await request('POST', `/v1/campaigns/${CAMPAIGN_ID}/messages`, {
    body: {
      tenant_id: TENANT,
      from: { email: 'marketing@localhost.test' },
      messages: [
        {
          idempotency_key: `${TENANT}-1`,
          to: [{ email: 'user1@example.com' }],
          subject: subject1,
          content: { text: 'dup' },
        },
      ],
    },
  });
  if (dup.status === 202 && dup.json?.accepted === 1) {
    pass('Campaign idempotency replay');
  } else {
    fail('Campaign idempotency replay', `status=${dup.status}`);
  }

  if (webhookEvents.some((e) => e.event_type === 'message.opened')) {
    pass('Webhook message.opened');
  } else {
    fail(
      'Webhook message.opened',
      'no event captured — start gateway with LITEDESK_WEBHOOK_URL=http://127.0.0.1:3997/api/internal/webhooks/amds'
    );
  }

  if (webhookEvents.some((e) => e.event_type === 'message.clicked')) {
    pass('Webhook message.clicked');
  } else {
    fail(
      'Webhook message.clicked',
      'no event captured — start gateway with LITEDESK_WEBHOOK_URL=http://127.0.0.1:3997/api/internal/webhooks/amds'
    );
  }

  await finish(results.some((r) => !r.ok) ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await finish(1);
});
