#!/usr/bin/env node
/**
 * Delivery isolation validation — reputation→pool routing, inventory, ops, failure attribution helpers.
 * Usage: npm run validate:isolation
 * Requires: gateway running (npm run dev)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  riskTierFromScore,
  resolvePoolId,
  attributeFailureClass,
  shouldAffectInfraPressure,
  shouldAffectTenantReputation,
  PermanentSmtpError,
  RetryableSmtpError,
} from '@vmds/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
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

async function request(method, urlPath, { body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
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
  console.log('Delivery isolation validation\n');

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY not set');
    process.exit(1);
  }

  // Unit-level selector checks (no network)
  if (riskTierFromScore(96) === 'healthy' && riskTierFromScore(70) === 'standard' && riskTierFromScore(40) === 'restricted') {
    pass('Risk tiers', '96/70/40');
  } else {
    fail('Risk tiers');
  }

  if (
    resolvePoolId('campaign', null, 96) === 'marketing_healthy' &&
    resolvePoolId('campaign', null, 70) === 'marketing_standard' &&
    resolvePoolId('campaign', null, 40) === 'marketing_restricted' &&
    resolvePoolId('transaction', null, 40) === 'transaction'
  ) {
    pass('Pool resolution', 'purpose × tier');
  } else {
    fail('Pool resolution', JSON.stringify({
      h: resolvePoolId('campaign', null, 96),
      s: resolvePoolId('campaign', null, 70),
      r: resolvePoolId('campaign', null, 40),
    }));
  }

  const recipFail = attributeFailureClass(new PermanentSmtpError('550 5.1.1 User unknown'));
  const infraFail = attributeFailureClass(new RetryableSmtpError('ETIMEDOUT connecting'));
  if (
    recipFail === 'recipient' &&
    shouldAffectTenantReputation(recipFail) &&
    !shouldAffectInfraPressure(recipFail) &&
    infraFail === 'infra' &&
    shouldAffectInfraPressure(infraFail) &&
    !shouldAffectTenantReputation(infraFail)
  ) {
    pass('Failure attribution', 'recipient vs infra');
  } else {
    fail('Failure attribution', `${recipFail}/${infraFail}`);
  }

  const ops = await request('GET', '/ops', { auth: false });
  if (ops.status === 200 && String(ops.text).includes('AMDS Ops')) {
    pass('Ops UI', '/ops');
  } else {
    fail('Ops UI', `status=${ops.status}`);
  }

  const pools = await request('GET', '/v1/admin/ip-pools');
  const ids = (pools.json?.pools ?? []).map((p) => p.pool_id);
  if (
    pools.status === 200 &&
    ids.includes('transaction') &&
    ids.includes('marketing_healthy') &&
    ids.includes('marketing_standard') &&
    ids.includes('marketing_restricted')
  ) {
    pass('IP pools seeded', ids.join(','));
  } else {
    fail('IP pools seeded', `status=${pools.status} ids=${ids.join(',')}`);
  }

  const inv = await request('GET', '/v1/admin/ip-inventory');
  if (inv.status === 200 && (inv.json?.inventory?.length ?? 0) >= 4) {
    pass('IP inventory', `${inv.json.inventory.length} rows`);
  } else {
    fail('IP inventory', `status=${inv.status}`);
  }

  const tenant = `iso-${Date.now()}`;
  await request('PUT', `/v1/tenants/${tenant}/policy`, {
    body: {
      status: 'active',
      monthly_credits: 1000,
      credits_remaining: 1000,
      daily_send_limit: 1000,
      max_hourly_rate: 500,
      burst_rate_per_min: 50,
      max_campaign_size: 100,
      warmup_enabled: false,
      reputation_enabled: true,
    },
  });

  await request('POST', `/v1/admin/tenants/${tenant}/reputation`, {
    body: { score: 95, reason: 'isolation validation healthy' },
  });
  const routeHealthy = await request('GET', `/v1/admin/tenants/${tenant}/routing`);
  if (
    routeHealthy.status === 200 &&
    routeHealthy.json?.risk_tier === 'healthy' &&
    routeHealthy.json?.resolved?.marketing_pool === 'marketing_healthy'
  ) {
    pass('Routing healthy', JSON.stringify(routeHealthy.json.resolved));
  } else {
    fail('Routing healthy', JSON.stringify(routeHealthy.json));
  }

  await request('POST', `/v1/admin/tenants/${tenant}/reputation`, {
    body: { score: 45, reason: 'isolation validation restricted' },
  });
  const routeBad = await request('GET', `/v1/admin/tenants/${tenant}/routing`);
  if (
    routeBad.status === 200 &&
    routeBad.json?.risk_tier === 'restricted' &&
    routeBad.json?.resolved?.marketing_pool === 'marketing_restricted' &&
    routeBad.json?.resolved?.transaction_pool === 'transaction'
  ) {
    pass('Routing restricted', JSON.stringify(routeBad.json.resolved));
  } else {
    fail('Routing restricted', JSON.stringify(routeBad.json));
  }

  // Register a free IP and assign dedicated
  const freeIp = `203.0.113.${(Date.now() % 200) + 20}`;
  const reg = await request('POST', '/v1/admin/ip-inventory', {
    body: {
      egress_ip: freeIp,
      purpose: 'marketing',
      risk_tier: 'healthy',
      attached: true,
      state: 'free',
      notes: 'isolation validation',
    },
  });
  if (reg.status === 201) {
    pass('Register inventory IP', freeIp);
  } else {
    fail('Register inventory IP', JSON.stringify(reg.json));
  }

  const assign = await request('POST', `/v1/admin/tenants/${tenant}/egress`, {
    body: { purpose: 'marketing', egress_ip: freeIp },
  });
  if (assign.status === 201 && assign.json?.egress_ip === freeIp) {
    pass('Assign dedicated IP', freeIp);
  } else {
    fail('Assign dedicated IP', JSON.stringify(assign.json));
  }

  const release = await request('DELETE', `/v1/admin/tenants/${tenant}/egress/marketing`);
  if (release.status === 200 && release.json?.released) {
    pass('Release dedicated IP');
  } else {
    fail('Release dedicated IP', JSON.stringify(release.json));
  }

  const infra = await request('GET', '/v1/admin/infra/status');
  if (infra.status === 200 && infra.json?.pools && infra.json?.inventory_summary) {
    pass('Infra status enriched');
  } else {
    fail('Infra status enriched', `status=${infra.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    process.exit(1);
  }
  console.log('Delivery isolation — PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
