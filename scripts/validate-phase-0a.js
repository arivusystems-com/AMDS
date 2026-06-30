#!/usr/bin/env node
/**
 * Phase 0a exit validation — run while gateway + worker are up.
 * Usage: npm run validate:phase-0a
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const MAILPIT_URL = process.env.MAILPIT_API_URL || 'http://localhost:8025';
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

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

async function pollMessageStatus(messageId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { status, json } = await request('GET', `/v1/messages/${messageId}`);
    if (status === 200 && json?.status === 'delivered') {
      return json;
    }
    if (status === 200 && json?.status === 'failed') {
      throw new Error(json.error_message || 'Message delivery failed');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timed out waiting for delivered status (${POLL_TIMEOUT_MS}ms)`);
}

async function mailpitHasSubject(subject) {
  try {
    const response = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(subject)}`
    );
    if (!response.ok) return false;
    const json = await response.json();
    return Number(json.count || 0) > 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`Phase 0a validation → ${BASE_URL}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY is not set in .env');
    process.exit(1);
  }

  // 1. Health
  const health = await request('GET', '/health', { auth: false });
  if (health.status === 200 && health.json?.status === 'ok') {
    pass('GET /health');
  } else {
    fail('GET /health', `status ${health.status}`);
  }

  // 2. Ready (Postgres + Redis)
  const ready = await request('GET', '/ready', { auth: false });
  if (ready.status === 200 && ready.json?.status === 'ready') {
    pass('GET /ready', 'postgres + redis');
  } else {
    fail('GET /ready', JSON.stringify(ready.json?.checks || ready.status));
  }

  // 3. Auth rejection
  const noAuth = await request('POST', '/v1/messages', {
    auth: false,
    body: { idempotency_key: 'x', tenant_id: 't', from: { email: 'a@b.c' }, to: [{ email: 'd@e.f' }], subject: 'x', content: { text: 'x' } },
  });
  if (noAuth.status === 401) {
    pass('POST /v1/messages without auth → 401');
  } else {
    fail('POST /v1/messages without auth → 401', `got ${noAuth.status}`);
  }

  // 4. Validation rejection
  const badPayload = await request('POST', '/v1/messages', {
    body: { tenant_id: 'org_local', subject: 'missing fields' },
  });
  if (badPayload.status === 400) {
    pass('POST /v1/messages invalid payload → 400');
  } else {
    fail('POST /v1/messages invalid payload → 400', `got ${badPayload.status}`);
  }

  // 5. Send + deliver
  const idempotencyKey = `phase-0a-${Date.now()}`;
  const subject = `Phase 0a validation ${Date.now()}`;
  const payload = {
    idempotency_key: idempotencyKey,
    tenant_id: 'org_local',
    from: { email: 'support@localhost.test', name: 'AMDS Phase 0a' },
    to: [{ email: 'user@example.com', name: 'Validator' }],
    subject,
    content: {
      html: '<p>Phase 0a validation email</p>',
      text: 'Phase 0a validation email',
    },
    metadata: { litedesk_module: 'crm', validation: 'phase-0a' },
    tags: ['transactional', 'validation'],
  };

  const send = await request('POST', '/v1/messages', { body: payload });
  if (send.status !== 202 || !send.json?.message_id) {
    fail('POST /v1/messages → 202 + message_id', `status ${send.status}`);
    printSummary();
    process.exit(1);
  }
  pass('POST /v1/messages → 202', send.json.message_id);

  const messageId = send.json.message_id;

  try {
    const delivered = await pollMessageStatus(messageId);
    pass('Worker delivery', `status=${delivered.status}`);
  } catch (err) {
    fail(
      'Worker delivery',
      `${err.message}. Is the worker running? (npm run dev:worker)`
    );
    printSummary();
    process.exit(1);
  }

  // 6. Idempotency
  const dup = await request('POST', '/v1/messages', { body: payload });
  if (dup.status === 200 && dup.json?.message_id === messageId) {
    pass('Idempotency replay', 'same message_id, HTTP 200');
  } else {
    fail(
      'Idempotency replay',
      `expected 200 + ${messageId}, got ${dup.status} + ${dup.json?.message_id}`
    );
  }

  // 7. Mailpit (optional — requires Mailpit on :8025)
  if (await mailpitHasSubject(subject)) {
    pass('Mailpit', `found "${subject}"`);
  } else {
    fail('Mailpit', `message not found at ${MAILPIT_URL} (is Mailpit running?)`);
  }

  printSummary();
  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed === 0) {
    console.log('\nPhase 0a (AMDS local) — PASSED');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
