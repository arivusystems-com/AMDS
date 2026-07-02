#!/usr/bin/env node
/**
 * Track 5 validation — production hardening checks.
 * Usage: npm run validate:track-5
 *
 * Requires gateway + worker running.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const WORKER_METRICS_URL =
  process.env.WORKER_METRICS_URL ||
  `http://localhost:${process.env.WORKER_METRICS_PORT || 9091}`;
const API_KEY = process.env.AMDS_API_KEY;

const results = [];

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(url, { auth = false } = {}) {
  const headers = { Accept: 'text/plain, application/json' };
  if (auth && API_KEY) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }
  const response = await fetch(url, { headers });
  const text = await response.text();
  return { status: response.status, text };
}

async function main() {
  console.log(`Track 5 validation → ${BASE_URL}\n`);

  const health = await request(`${BASE_URL}/health`);
  if (health.status === 200 && health.text.includes('"status":"ok"')) {
    pass('GET /health');
  } else {
    fail('GET /health', `status=${health.status}`);
  }

  const ready = await request(`${BASE_URL}/ready`);
  if (ready.status === 200 && ready.text.includes('"postgres":true')) {
    pass('GET /ready', 'postgres + redis');
  } else {
    fail('GET /ready', `status=${ready.status}`);
  }

  const metrics = await request(`${BASE_URL}/metrics`);
  const requiredMetrics = [
    'amds_http_requests_total',
    'amds_queue_jobs',
    'amds_messages_by_status',
    'amds_webhook_outbox_pending',
  ];
  const missing = requiredMetrics.filter((m) => !metrics.text.includes(m));
  if (metrics.status === 200 && missing.length === 0) {
    pass('GET /metrics (gateway)', `${requiredMetrics.length} metric families`);
  } else {
    fail('GET /metrics (gateway)', missing.length ? `missing: ${missing.join(', ')}` : `status=${metrics.status}`);
  }

  const workerMetrics = await request(`${WORKER_METRICS_URL}/metrics`);
  if (
    workerMetrics.status === 200 &&
    workerMetrics.text.includes('amds_worker_deliveries_total')
  ) {
    pass('GET /metrics (worker)', WORKER_METRICS_URL);
  } else {
    fail(
      'GET /metrics (worker)',
      `status=${workerMetrics.status} — is worker running with METRICS_ENABLED=true?`
    );
  }

  if (API_KEY) {
    const send = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `track5-${Date.now()}`,
        tenant_id: 'track5-validate',
        from: { email: 'noreply@localhost.test', name: 'Track 5' },
        to: [{ email: 'track5@example.com' }],
        subject: 'Track 5 metrics smoke',
        content: { text: 'Track 5 validation send' },
      }),
    });
    if (send.status === 202 || send.status === 200) {
      pass('POST /v1/messages smoke', `status=${send.status}`);
    } else {
      fail('POST /v1/messages smoke', `status=${send.status}`);
    }

    const metricsAfter = await request(`${BASE_URL}/metrics`);
    if (metricsAfter.text.includes('amds_http_requests_total')) {
      pass('HTTP metrics increment after request');
    } else {
      fail('HTTP metrics increment after request');
    }
  } else {
    fail('Environment', 'AMDS_API_KEY not set — skipped send smoke test');
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('Track 5 (AMDS local) — PASSED');
    process.exit(0);
  } else {
    console.log(`Track 5 (AMDS local) — FAILED (${failed.length} checks)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
