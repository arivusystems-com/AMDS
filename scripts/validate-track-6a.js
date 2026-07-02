#!/usr/bin/env node
/**
 * Track 6 Phase 1 validation — tenant policies, credits, limits.
 * Usage: TENANT_POLICIES_REQUIRED=true npm run validate:track-6a
 *
 * Run while gateway + worker are up.
 */

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const TENANT = `track6a-${Date.now()}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

const results = [];
const tenantEvents = [];
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
            tenantEvents.push(JSON.parse(data));
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
    mockServer.listen(3998, '127.0.0.1', () => resolve());
  });
}

async function main() {
  console.log(`Track 6a validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  await startMockWebhookServer();

  const policyBody = {
    status: 'active',
    monthly_credits: 1000,
    credits_remaining: 10,
    daily_send_limit: 100,
    max_hourly_rate: 100,
    burst_rate_per_min: 50,
    max_campaign_size: 5,
    warmup_enabled: true,
    reputation_enabled: true,
  };

  const putPolicy = await request('PUT', `/v1/tenants/${TENANT}/policy`, { body: policyBody });
  if (putPolicy.status === 200 && putPolicy.json?.tenant_id === TENANT) {
    pass('PUT /v1/tenants/:id/policy', `credits=${putPolicy.json.credits_remaining}`);
  } else {
    fail('PUT /v1/tenants/:id/policy', `status=${putPolicy.status}`);
  }

  const getPolicy = await request('GET', `/v1/tenants/${TENANT}/policy`);
  if (getPolicy.status === 200 && getPolicy.json?.max_hourly_rate === 100) {
    pass('GET /v1/tenants/:id/policy');
  } else {
    fail('GET /v1/tenants/:id/policy', `status=${getPolicy.status}`);
  }

  const send = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-send-1`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test', name: 'Track 6a' },
      to: [{ email: 'user@example.com' }],
      subject: `Track 6a credit test ${TENANT}`,
      content: { text: 'credit lifecycle test' },
    },
  });

  if (send.status !== 202) {
    fail('POST /v1/messages (with policy)', `status=${send.status} ${JSON.stringify(send.json)}`);
  } else {
    pass('POST /v1/messages (with policy)', `message_id=${send.json.message_id}`);
  }

  const afterReserve = await request('GET', `/v1/tenants/${TENANT}/policy`);
  if (afterReserve.json?.credits_remaining === 9 && afterReserve.json?.credits_reserved === 1) {
    pass('Credit reserve on accept', 'remaining=9 reserved=1');
  } else {
    fail(
      'Credit reserve on accept',
      `remaining=${afterReserve.json?.credits_remaining} reserved=${afterReserve.json?.credits_reserved}`
    );
  }

  if (send.json?.message_id) {
    await pollMessage(send.json.message_id, (m) => m.status === 'delivered');
    pass('Message delivered', send.json.message_id);

    const afterConsume = await request('GET', `/v1/tenants/${TENANT}/policy`);
    if (afterConsume.json?.credits_remaining === 9 && afterConsume.json?.credits_reserved === 0) {
      pass('Credit consume on delivery', 'reserved=0');
    } else {
      fail(
        'Credit consume on delivery',
        `remaining=${afterConsume.json?.credits_remaining} reserved=${afterConsume.json?.credits_reserved}`
      );
    }
  }

  const allocate = await request('PATCH', `/v1/tenants/${TENANT}/credits`, {
    body: { amount: 5, reason: 'test pack' },
  });
  if (allocate.status === 200 && allocate.json?.credits_remaining === 14) {
    pass('PATCH /v1/tenants/:id/credits', 'remaining=14');
  } else {
    fail('PATCH /v1/tenants/:id/credits', `status=${allocate.status}`);
  }

  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: { ...policyBody, credits_remaining: 0 },
  });

  const noCredits = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-no-credits`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'broke@example.com' }],
      subject: 'should fail',
      content: { text: 'no credits' },
    },
  });
  if (noCredits.status === 402) {
    pass('Insufficient credits → 402');
  } else {
    fail('Insufficient credits → 402', `status=${noCredits.status}`);
  }

  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: { ...policyBody, credits_remaining: 50, status: 'active' },
  });
  await request('POST', `/v1/tenants/${TENANT}/suspend`);

  const suspended = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-suspended`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'blocked@example.com' }],
      subject: 'suspended tenant',
      content: { text: 'blocked' },
    },
  });
  if (suspended.status === 403) {
    pass('Suspended tenant → 403');
  } else {
    fail('Suspended tenant → 403', `status=${suspended.status}`);
  }

  await request('POST', `/v1/tenants/${TENANT}/activate`);
  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: {
      ...policyBody,
      credits_remaining: 100,
      max_campaign_size: 2,
    },
  });

  const bigCampaign = await request('POST', '/v1/campaigns/camp-big/messages', {
    body: {
      tenant_id: TENANT,
      from: { email: 'news@localhost.test' },
      messages: [
        {
          idempotency_key: `${TENANT}-c1`,
          to: [{ email: 'a@example.com' }],
          subject: 'a',
          content: { text: 'a' },
        },
        {
          idempotency_key: `${TENANT}-c2`,
          to: [{ email: 'b@example.com' }],
          subject: 'b',
          content: { text: 'b' },
        },
        {
          idempotency_key: `${TENANT}-c3`,
          to: [{ email: 'c@example.com' }],
          subject: 'c',
          content: { text: 'c' },
        },
      ],
    },
  });
  if (bigCampaign.status === 422 && bigCampaign.json?.error === 'campaign_size_exceeded') {
    pass('Campaign size limit → 422');
  } else {
    fail('Campaign size limit → 422', `status=${bigCampaign.status}`);
  }

  if (mockServer) {
    mockServer.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6a (AMDS Phase 1) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6a — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  if (mockServer) {
    mockServer.close();
  }
  process.exit(1);
});
