#!/usr/bin/env node
/**
 * Track 6 Phase 3 validation — dynamic throughput & warm-up.
 * Usage: npm run validate:track-6c
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const TENANT = `track6c-${Date.now()}`;
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

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

async function main() {
  console.log(`Track 6c validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  const basePolicy = {
    status: 'active',
    monthly_credits: 100_000,
    credits_remaining: 100_000,
    daily_send_limit: 100_000,
    max_hourly_rate: 5000,
    burst_rate_per_min: 200,
    max_campaign_size: 50_000,
    warmup_enabled: false,
    reputation_enabled: true,
  };

  await request('PUT', `/v1/tenants/${TENANT}/policy`, { body: basePolicy });
  pass('PUT policy', 'max_hourly=5000');

  await request('POST', `/v1/admin/tenants/${TENANT}/reputation`, {
    body: { score: 82, reason: 'track6c baseline' },
  });

  const throughput = await request('GET', `/v1/tenants/${TENANT}/throughput`);
  if (
    throughput.status === 200 &&
    throughput.json?.effective_hourly_rate === 3750 &&
    throughput.json?.multipliers?.reputation === 0.75
  ) {
    pass('Reputation multiplier throughput', '3750/hr');
  } else {
    fail(
      'Reputation multiplier throughput',
      `effective=${throughput.json?.effective_hourly_rate} rep=${throughput.json?.multipliers?.reputation}`
    );
  }

  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: { ...basePolicy, warmup_enabled: true },
  });

  const warmSend = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-warmup`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'warmup@example.com' }],
      subject: `Warmup ${TENANT}`,
      content: { text: 'warmup' },
    },
  });
  if (warmSend.status === 202) {
    await pollMessage(warmSend.json.message_id, (m) => m.status === 'delivered');
    pass('First send establishes warm-up', warmSend.json.message_id);
  } else {
    fail('First send for warm-up', `status=${warmSend.status}`);
  }

  const warmThroughput = await request('GET', `/v1/tenants/${TENANT}/throughput`);
  if (
    warmThroughput.status === 200 &&
    warmThroughput.json?.multipliers?.warmup_stage === 'day_1' &&
    warmThroughput.json?.effective_hourly_rate <= 250
  ) {
    pass('Warm-up day 1 cap', `effective=${warmThroughput.json.effective_hourly_rate}`);
  } else {
    fail(
      'Warm-up day 1 cap',
      `stage=${warmThroughput.json?.multipliers?.warmup_stage} effective=${warmThroughput.json?.effective_hourly_rate}`
    );
  }

  const estimate = await request(
    'GET',
    `/v1/campaigns/june/estimate?tenant_id=${TENANT}&recipient_count=25000`
  );
  if (estimate.status === 200 && estimate.json?.estimated_seconds > 0) {
    pass('Campaign ETA', estimate.json.estimated_completion);
  } else {
    fail('Campaign ETA', `status=${estimate.status}`);
  }

  await request('POST', `/v1/admin/tenants/${TENANT}/reputation`, {
    body: { score: 35, reason: 'track6c marketing block test' },
  });

  const campaignBlocked = await request('POST', '/v1/campaigns/blocked/messages', {
    body: {
      tenant_id: TENANT,
      from: { email: 'news@localhost.test' },
      messages: [
        {
          idempotency_key: `${TENANT}-camp-block`,
          to: [{ email: 'a@example.com' }],
          subject: 'blocked',
          content: { text: 'x' },
        },
      ],
    },
  });
  if (campaignBlocked.status === 403 && campaignBlocked.json?.error === 'marketing_restricted') {
    pass('Marketing restricted below 40', '403');
  } else {
    fail('Marketing restricted below 40', `status=${campaignBlocked.status}`);
  }

  const txnAllowed = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-txn-35`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'help@example.com' }],
      subject: 'transactional ok',
      content: { text: 'txn' },
    },
  });
  if (txnAllowed.status === 202) {
    pass('Transactional allowed at reputation 35');
  } else {
    fail('Transactional allowed at reputation 35', `status=${txnAllowed.status}`);
  }

  await request('POST', `/v1/admin/tenants/${TENANT}/reputation`, {
    body: { score: 15, reason: 'track6c suspend test' },
  });

  const sendBlocked = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `${TENANT}-suspend`,
      tenant_id: TENANT,
      from: { email: 'noreply@localhost.test' },
      to: [{ email: 'blocked@example.com' }],
      subject: 'blocked',
      content: { text: 'blocked' },
    },
  });
  if (sendBlocked.status === 403 && sendBlocked.json?.error === 'reputation_too_low') {
    pass('Sending suspended below 20', '403');
  } else {
    fail('Sending suspended below 20', `status=${sendBlocked.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6c (AMDS Phase 3) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6c — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
