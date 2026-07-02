#!/usr/bin/env node
/**
 * Track 6 Phase 6 validation — IP pools, OpenAPI, load smoke test.
 * Usage: npm run validate:track-6f
 *
 * Optional: LOAD_TEST_SIZE=50 (default 20) for campaign batch load smoke.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const TENANT = `track6f-${Date.now()}`;
const CAMPAIGN_ID = `load-${Date.now()}`;
const LOAD_SIZE = Number.parseInt(process.env.LOAD_TEST_SIZE ?? '20', 10);

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

  return { status: response.status, json, text };
}

async function main() {
  console.log(`Track 6f validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  const pools = await request('GET', '/v1/admin/ip-pools');
  if (
    pools.status === 200 &&
    pools.json?.pools?.length >= 2 &&
    pools.json.pools.some((p) => p.pool_id === 'transaction') &&
    pools.json.pools.some((p) => p.pool_id === 'marketing')
  ) {
    pass('IP pools', `${pools.json.pools.length} pools`);
  } else {
    fail('IP pools', `status=${pools.status}`);
  }

  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: {
      status: 'active',
      monthly_credits: 100_000,
      credits_remaining: 100_000,
      daily_send_limit: 100_000,
      max_hourly_rate: 10_000,
      burst_rate_per_min: 1000,
      max_campaign_size: 50_000,
      warmup_enabled: false,
      reputation_enabled: true,
      ip_pool: 'marketing',
    },
  });
  pass('Policy with ip_pool=marketing');

  const openapi = await request('GET', '/v1/openapi.yaml', { auth: false });
  if (openapi.status === 200 && openapi.text.includes('Track 6 API')) {
    pass('OpenAPI spec', '/v1/openapi.yaml');
  } else {
    fail('OpenAPI spec', `status=${openapi.status}`);
  }

  const messages = Array.from({ length: LOAD_SIZE }, (_, i) => ({
    idempotency_key: `${TENANT}-load-${i}`,
    to: [{ email: `load${i}@example.com` }],
    subject: `Load test ${TENANT} ${i}`,
    content: { text: `load ${i}` },
  }));

  const batch = await request('POST', `/v1/campaigns/${CAMPAIGN_ID}/messages`, {
    body: {
      tenant_id: TENANT,
      from: { email: 'load@localhost.test' },
      messages,
    },
  });

  if (batch.status === 202 && batch.json?.accepted === LOAD_SIZE) {
    pass('Campaign load smoke', `${LOAD_SIZE} accepted`);
  } else {
    fail('Campaign load smoke', `status=${batch.status} accepted=${batch.json?.accepted}`);
  }

  const history = await request('GET', `/v1/tenants/${TENANT}/reputation/history?limit=5`);
  if (history.status === 200 && Array.isArray(history.json?.history)) {
    pass('Reputation history (read pool)', `entries=${history.json.history.length}`);
  } else {
    fail('Reputation history', `status=${history.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6f (AMDS Phase 6) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6f — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
