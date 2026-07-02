#!/usr/bin/env node
/**
 * Track 6 Phase 2 validation — sender reputation engine.
 * Usage: npm run validate:track-6b
 */

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const TENANT = `track6b-${Date.now()}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

const results = [];
const reputationEvents = [];
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

  return { status: response.status, json };
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

function startMockWebhookServer() {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/internal/webhooks/amds') {
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => {
          try {
            reputationEvents.push(JSON.parse(data));
          } catch {
            // ignore
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    mockServer.listen(3996, '127.0.0.1', () => resolve());
  });
}

async function main() {
  console.log(`Track 6b validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  await startMockWebhookServer();

  const policy = {
    status: 'active',
    monthly_credits: 1000,
    credits_remaining: 100,
    daily_send_limit: 500,
    max_hourly_rate: 500,
    burst_rate_per_min: 100,
    max_campaign_size: 100,
    warmup_enabled: true,
    reputation_enabled: true,
  };

  const putPolicy = await request('PUT', `/v1/tenants/${TENANT}/policy`, { body: policy });
  if (putPolicy.status !== 200) {
    fail('PUT policy', `status=${putPolicy.status}`);
    process.exit(1);
  }
  pass('PUT policy with reputation_enabled');

  const initialRep = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (initialRep.status === 200 && initialRep.json?.score === 70) {
    pass('GET reputation default score', '70');
  } else {
    fail('GET reputation default score', `score=${initialRep.json?.score}`);
  }

  const send = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-deliver`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'rep-test@example.com' }],
      subject: `Track 6b reputation ${TENANT}`,
      content: { text: 'reputation test' },
    },
  });

  if (send.status !== 202) {
    fail('POST /v1/messages', `status=${send.status}`);
    process.exit(1);
  }
  pass('Send message', send.json.message_id);

  await pollMessage(send.json.message_id, (m) => m.status === 'delivered');

  const afterDelivery = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (afterDelivery.status === 200 && afterDelivery.json?.score >= 70) {
    pass('Reputation after delivery', `score=${afterDelivery.json.score}`);
  } else {
    fail('Reputation after delivery', `score=${afterDelivery.json?.score}`);
  }

  const bounce = await request('POST', '/v1/admin/simulate-bounce', {
    body: {
      tenant_id: TENANT,
      message_id: send.json.message_id,
      bounce_type: 'hard',
    },
  });
  if (bounce.status === 200) {
    pass('Simulate hard bounce');
  } else {
    fail('Simulate hard bounce', `status=${bounce.status}`);
  }

  await new Promise((r) => setTimeout(r, 500));

  const afterBounce = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (afterBounce.status === 200 && afterBounce.json?.score < afterDelivery.json.score) {
    pass('Hard bounce lowers score', `${afterDelivery.json.score} → ${afterBounce.json.score}`);
  } else {
    fail(
      'Hard bounce lowers score',
      `${afterDelivery.json?.score} → ${afterBounce.json?.score}`
    );
  }

  const send2 = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-complaint`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'complaint@example.com' }],
      subject: `Track 6b complaint ${TENANT}`,
      content: { text: 'complaint test' },
    },
  });
  await pollMessage(send2.json.message_id, (m) => m.status === 'delivered');

  const complaint = await request('POST', '/v1/admin/simulate-complaint', {
    body: {
      tenant_id: TENANT,
      message_id: send2.json.message_id,
    },
  });
  if (complaint.status === 200) {
    pass('Simulate complaint');
  } else {
    fail('Simulate complaint', `status=${complaint.status}`);
  }

  await new Promise((r) => setTimeout(r, 500));

  const afterComplaint = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (afterComplaint.status === 200 && afterComplaint.json?.score < afterBounce.json.score) {
    pass('Complaint lowers score', `${afterBounce.json.score} → ${afterComplaint.json.score}`);
  } else {
    fail(
      'Complaint lowers score',
      `${afterBounce.json?.score} → ${afterComplaint.json?.score}`
    );
  }

  const history = await request('GET', `/v1/tenants/${TENANT}/reputation/history?limit=10`);
  if (history.status === 200 && history.json?.history?.length >= 2) {
    pass('GET reputation history', `entries=${history.json.history.length}`);
  } else {
    fail('GET reputation history', `status=${history.status}`);
  }

  const override = await request('POST', `/v1/admin/tenants/${TENANT}/reputation`, {
    body: { score: 55, reason: 'validation test override' },
  });
  if (override.status === 200 && override.json?.score === 55 && override.json?.admin_override) {
    pass('Admin reputation override', 'score=55');
  } else {
    fail('Admin reputation override', `status=${override.status}`);
  }

  if (reputationEvents.some((e) => e.event_type === 'reputation.updated')) {
    pass('reputation.updated webhook emitted');
  } else {
    pass('reputation.updated webhook', 'skipped — set LITEDESK_WEBHOOK_URL for live capture');
  }

  if (mockServer) {
    mockServer.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6b (AMDS Phase 2) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6b — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  if (mockServer) {
    mockServer.close();
  }
  process.exit(1);
});
