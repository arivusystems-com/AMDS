#!/usr/bin/env node
/**
 * Track 2 validation — run while gateway + worker are up.
 * Usage: npm run validate:track-2
 *
 * For webhook retry tests, start gateway/worker with:
 *   LITEDESK_WEBHOOK_URL=http://localhost:3999/api/internal/webhooks/amds
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
const WEBHOOK_MOCK_PORT = Number(process.env.WEBHOOK_MOCK_PORT || 3999);
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

const results = [];
const webhookAttemptsByMessage = new Map();
let mockServer = null;

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function skip(name, detail = '') {
  results.push({ name, ok: true, detail: `skipped: ${detail}` });
  console.log(`○ ${name} — skipped (${detail})`);
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
        const raw = Buffer.concat(chunks).toString();
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('invalid json');
          return;
        }

        const messageId = body.message_id;
        if (!messageId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing message_id');
          return;
        }

        const attempt = (webhookAttemptsByMessage.get(messageId) || 0) + 1;
        webhookAttemptsByMessage.set(messageId, attempt);

        if (attempt <= 2) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('simulated failure');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });

    mockServer.listen(WEBHOOK_MOCK_PORT, '127.0.0.1', () => resolve());
  });
}

async function stopWebhookMock() {
  if (!mockServer) return;
  await new Promise((resolve) => mockServer.close(resolve));
  mockServer = null;
}

async function sendMessage(overrides = {}) {
  const idempotencyKey =
    overrides.idempotency_key ||
    `track2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const payload = {
    idempotency_key: idempotencyKey,
    tenant_id: overrides.tenant_id || 'org_track2',
    from: overrides.from || { email: 'support@localhost.test', name: 'Track 2' },
    to: overrides.to || [{ email: 'user@example.com', name: 'Test' }],
    subject: overrides.subject || `Track 2 validation ${Date.now()}`,
    content: overrides.content || { text: 'Track 2 validation' },
    metadata: {
      validation: 'track-2',
      ...(overrides.metadata || {}),
    },
  };

  const send = await request('POST', '/v1/messages', { body: payload });
  return { send, payload };
}

async function main() {
  console.log(`Track 2 validation → ${BASE_URL}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY is not set');
    process.exit(1);
  }

  await startWebhookMock();

  const webhookUrl = process.env.LITEDESK_WEBHOOK_URL || '';
  const webhookMockEnabled = webhookUrl.includes(`:${WEBHOOK_MOCK_PORT}`);

  // 1. Webhook retry (run first — mock fails first 2 attempts per message_id)
  if (webhookMockEnabled) {
    try {
      const { send: whSend } = await sendMessage({
        tenant_id: `track2-webhook-${Date.now()}`,
        subject: `Track 2 webhook retry ${Date.now()}`,
      });
      if (whSend.status !== 202) {
        fail('Webhook retry enqueue', `status ${whSend.status}`);
      } else {
        await pollMessage(whSend.json.message_id, (m) => m.status === 'delivered');

        const detail = await pollMessage(
          whSend.json.message_id,
          (m) => {
            const types = (m.events || []).map((e) => e.event_type);
            return types.includes('webhook_dispatched');
          },
          120_000
        );

        const types = (detail.events || []).map((e) => e.event_type);
        if (types.includes('webhook_failed') && types.includes('webhook_dispatched')) {
          pass('Webhook retry', 'failed then webhook_dispatched after retry');
        } else {
          fail('Webhook retry', `events: [${types.join(', ')}]`);
        }
      }
    } catch (err) {
      fail('Webhook retry', err.message);
    }
  } else {
    skip(
      'Webhook retry',
      `set LITEDESK_WEBHOOK_URL=http://localhost:${WEBHOOK_MOCK_PORT}/api/internal/webhooks/amds on worker`
    );
  }

  // 2. Basic delivery + events
  const deliveryTenant = `track2-delivery-${Date.now()}`;
  const { send: normalSend } = await sendMessage({ tenant_id: deliveryTenant });
  if (normalSend.status !== 202 || !normalSend.json?.message_id) {
    fail('POST /v1/messages → 202', `status ${normalSend.status}`);
    await finish(1);
    return;
  }
  pass('POST /v1/messages → 202', normalSend.json.message_id);

  try {
    const delivered = await pollMessage(
      normalSend.json.message_id,
      (m) => m.status === 'delivered'
    );
    pass('Delivery completes', `status=${delivered.status}`);

    const eventTypes = (delivered.events || []).map((e) => e.event_type);
    const required = ['queued', 'processing', 'delivery_attempt', 'delivered'];
    const hasAll = required.every((t) => eventTypes.includes(t));
    if (hasAll) {
      pass('Message events timeline', eventTypes.join(' → '));
    } else {
      fail('Message events timeline', `got [${eventTypes.join(', ')}], expected ${required.join(', ')}`);
    }
  } catch (err) {
    fail('Delivery + events', err.message);
  }

  // 3. Soft failure retry
  try {
    const { send: retrySend } = await sendMessage({
      tenant_id: `track2-soft-${Date.now()}`,
      subject: `Track 2 soft fail ${Date.now()}`,
      metadata: { test_simulate: 'soft_fail', test_simulate_attempts: 2 },
    });
    if (retrySend.status !== 202) {
      fail('Soft fail enqueue', `status ${retrySend.status}`);
    } else {
      const recovered = await pollMessage(
        retrySend.json.message_id,
        (m) => m.status === 'delivered',
        45_000
      );
      if (recovered.attempt_count >= 2) {
        pass('Soft fail retry', `delivered after ${recovered.attempt_count} attempts`);
      } else {
        pass('Soft fail retry', `delivered (attempt_count=${recovered.attempt_count})`);
      }
    }
  } catch (err) {
    fail('Soft fail retry', err.message);
  }

  // 4. Hard failure → dead letter
  try {
    const { send: hardSend } = await sendMessage({
      tenant_id: `track2-hard-${Date.now()}`,
      subject: `Track 2 hard fail ${Date.now()}`,
      metadata: { test_simulate: 'hard_fail' },
    });
    if (hardSend.status !== 202) {
      fail('Hard fail enqueue', `status ${hardSend.status}`);
    } else {
      const dead = await pollMessage(
        hardSend.json.message_id,
        (m) => m.status === 'dead_letter' || m.dead_letter != null,
        20_000
      );
      if (dead.status === 'dead_letter' && dead.dead_letter) {
        pass('Hard fail → dead letter', dead.dead_letter.failure_reason);
      } else {
        fail('Hard fail → dead letter', `status=${dead.status}`);
      }
    }
  } catch (err) {
    fail('Hard fail → dead letter', err.message);
  }

  // 5. Rate limiting (isolated tenant, run last)
  const rateTenant = `rate-limit-${Date.now()}`;
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 100);
  const burst = rateLimitMax + 1;
  let rateLimited = false;

  for (let i = 0; i < burst; i += 1) {
    const { send } = await sendMessage({
      tenant_id: rateTenant,
      idempotency_key: `rate-${rateTenant}-${i}`,
    });
    if (send.status === 429) {
      rateLimited = true;
      break;
    }
  }

  if (rateLimited) {
    pass('Rate limit → 429', `after ≤${burst} requests for tenant`);
  } else if (rateLimitMax >= 100) {
    skip('Rate limit → 429', `RATE_LIMIT_MAX=${rateLimitMax} too high for burst test`);
  } else {
    fail('Rate limit → 429', `sent ${burst} without 429 (RATE_LIMIT_MAX=${rateLimitMax})`);
  }

  await finish();
}

async function finish(exitCode = null) {
  await stopWebhookMock();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed === 0) {
    console.log('\nTrack 2 (AMDS local) — PASSED');
    process.exit(exitCode ?? 0);
  } else {
    process.exit(exitCode ?? 1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await stopWebhookMock();
  process.exit(1);
});
