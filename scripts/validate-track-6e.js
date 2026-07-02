#!/usr/bin/env node
/**
 * Track 6 Phase 5 validation — infrastructure protection & recovery.
 * Usage: npm run validate:track-6e
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const TENANT = `track6e-${Date.now()}`;

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
  console.log(`Track 6e validation — tenant ${TENANT}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  await request('PUT', `/v1/tenants/${TENANT}/policy`, {
    body: {
      status: 'active',
      monthly_credits: 10_000,
      credits_remaining: 10_000,
      daily_send_limit: 10_000,
      max_hourly_rate: 5000,
      burst_rate_per_min: 500,
      max_campaign_size: 500,
      warmup_enabled: false,
      reputation_enabled: true,
    },
  });
  pass('PUT policy');

  const baselineThroughput = await request('GET', `/v1/tenants/${TENANT}/throughput`);
  const baselineEffective = baselineThroughput.json?.effective_hourly_rate;

  await request('POST', '/v1/admin/infra/simulate-pressure', {
    body: { queue_depth: 5000 },
  });

  await request('GET', `/v1/admin/infra/status`);
  const pressured = await request('GET', `/v1/tenants/${TENANT}/throughput`);
  await request('DELETE', '/v1/admin/infra/simulate-pressure');

  if (
    pressured.status === 200 &&
    pressured.json?.multipliers?.infra < 1 &&
    pressured.json?.effective_hourly_rate < baselineEffective
  ) {
    pass(
      'Infra pressure reduces throughput',
      `${baselineEffective} → ${pressured.json.effective_hourly_rate} (infra=${pressured.json.multipliers.infra})`
    );
  } else {
    fail(
      'Infra pressure reduces throughput',
      `baseline=${baselineEffective} effective=${pressured.json?.effective_hourly_rate} infra=${pressured.json?.multipliers?.infra}`
    );
  }

  const infraStatus = await request('GET', '/v1/admin/infra/status');
  if (infraStatus.status === 200 && infraStatus.json?.egress?.ip_address) {
    pass('Egress IP status', infraStatus.json.egress.warmup_stage);
  } else {
    fail('Egress IP status', `status=${infraStatus.status}`);
  }

  const beforeSignal = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  const signal = await request('POST', `/v1/admin/tenants/${TENANT}/reputation/signal`, {
    body: { signal_type: 'blacklist', reason: 'track6e validation' },
  });
  if (
    signal.status === 200 &&
    signal.json?.score < beforeSignal.json?.score
  ) {
    pass('Blacklist signal lowers score', `${beforeSignal.json.score} → ${signal.json.score}`);
  } else {
    fail('Blacklist signal', `status=${signal.status}`);
  }

  const recovery = await request('GET', `/v1/tenants/${TENANT}/reputation`);
  if (
    recovery.status === 200 &&
    recovery.json?.recovery?.day_start_score !== undefined &&
    recovery.json?.recovery?.remaining_gain_today !== undefined
  ) {
    pass(
      'Recovery headroom exposed',
      `remaining=${recovery.json.recovery.remaining_gain_today}`
    );
  } else {
    fail('Recovery headroom', `status=${recovery.status}`);
  }

  const metrics = await request('GET', '/metrics', { auth: false });
  if (
    metrics.status === 200 &&
    metrics.text.includes('amds_infra_multiplier') &&
    metrics.text.includes('amds_tenant_reputation_score')
  ) {
    pass('Prometheus reputation/infra metrics');
  } else {
    fail('Prometheus metrics', `status=${metrics.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 6e (AMDS Phase 5) — PASSED');
    process.exit(0);
  }
  console.error(`Track 6e — FAILED (${failed.length} checks)`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
