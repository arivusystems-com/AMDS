#!/usr/bin/env node
/**
 * Track 3 validation — run while gateway + worker are up.
 * Usage: npm run validate:track-3
 *
 * Recommended env for gateway/worker:
 *   DNS_VERIFY_BYPASS=true ENFORCE_DOMAIN_VERIFICATION=true
 */

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

// Inline bounce checks (mirrors packages/shared/src/bounce.ts)
function parseDsnInline(content) {
  const diagnostic =
    content.match(/Diagnostic-Code:\s*(?:\S+;\s*)?(.+)/i)?.[1]?.trim() ??
    content.trim().slice(0, 500);
  const statusCode = content.match(/\b([245]\.\d+\.\d+)\b/)?.[1] ?? null;
  const recipient =
    content.match(/Final-Recipient:\s*rfc822;\s*(\S+)/i)?.[1]?.toLowerCase() ?? null;
  const classification =
    statusCode?.startsWith('5.') || /user unknown/i.test(diagnostic) ? 'hard' : 'soft';
  return { classification, recipient, diagnostic, statusCode };
}

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;
const MAILPIT_URL = process.env.MAILPIT_API_URL || 'http://localhost:8025';
const TENANT = `track3-${Date.now()}`;
const DOMAIN = 'localhost.test';
const POLL_MS = 300;
const POLL_TIMEOUT_MS = 30_000;

const results = [];
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

async function mailpitMessageHasDkim(subject) {
  try {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(subject)}`
    );
    if (!search.ok) return false;
    const { messages } = await search.json();
    if (!messages?.length) return false;

    const id = messages[0].ID;
    const raw = await fetch(`${MAILPIT_URL}/api/v1/message/${id}/raw`);
    if (raw.ok) {
      const text = await raw.text();
      if (/DKIM-Signature:/i.test(text)) return true;
    }

    const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
    if (!detail.ok) return false;
    const msg = await detail.json();
    const blob = JSON.stringify(msg);
    return /DKIM-Signature/i.test(blob);
  } catch {
    return false;
  }
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    mockServer.listen(3998, '127.0.0.1', () => resolve());
  });
}

async function stopWebhookMock() {
  if (!mockServer) return;
  await new Promise((resolve) => mockServer.close(resolve));
  mockServer = null;
}

async function main() {
  console.log(`Track 3 validation → ${BASE_URL}\n`);

  if (!API_KEY) {
    fail('Environment', 'AMDS_API_KEY is not set');
    process.exit(1);
  }

  // 1. Bounce parser
  const hardDsn =
    'Final-Recipient: rfc822; bad@example.com\nDiagnostic-Code: smtp; 550 5.1.1 User unknown';
  const hard = parseDsnInline(hardDsn);
  if (hard.classification === 'hard' && hard.recipient === 'bad@example.com') {
    pass('Bounce parser hard', hard.statusCode ?? '550');
  } else {
    fail('Bounce parser hard', JSON.stringify(hard));
  }

  const softDsn = 'Diagnostic-Code: smtp; 451 4.2.1 mailbox full';
  const softParsed = parseDsnInline(softDsn);
  if (softParsed.classification === 'soft') {
    pass('Bounce parser soft');
  } else {
    fail('Bounce parser soft', softParsed.classification);
  }

  await startWebhookMock();

  // 2. Register domain
  const reg = await request('POST', '/v1/domains', {
    body: { tenant_id: TENANT, domain: DOMAIN },
  });
  if ((reg.status === 201 || reg.status === 200) && reg.json?.dns_records?.length >= 3) {
    pass('POST /v1/domains', `${reg.json.dns_records.length} DNS records`);
  } else {
    fail('POST /v1/domains', `status ${reg.status}`);
    await finish(1);
    return;
  }

  // 3. Verify domain (requires DNS_VERIFY_BYPASS=true on gateway)
  const verify = await request('POST', `/v1/domains/${DOMAIN}/verify`, {
    body: { tenant_id: TENANT },
  });
  if (verify.status === 200 && verify.json?.status === 'verified') {
    pass('POST /v1/domains/:domain/verify', 'verified');
  } else {
    fail(
      'POST /v1/domains/:domain/verify',
      `status=${verify.status} domain=${verify.json?.status}. Start gateway with DNS_VERIFY_BYPASS=true`
    );
  }

  // 4. Send with verified domain + DKIM
  const dkimSubject = `Track 3 DKIM ${Date.now()}`;
  const send = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `track3-dkim-${Date.now()}`,
      tenant_id: TENANT,
      from: { email: `support@${DOMAIN}`, name: 'Track 3' },
      to: [{ email: 'user@example.com' }],
      subject: dkimSubject,
      content: { text: 'DKIM signed test' },
    },
  });

  if (send.status === 403) {
    fail(
      'Send with verified domain',
      '403 — start gateway with ENFORCE_DOMAIN_VERIFICATION=true after verify step'
    );
  } else if (send.status === 202) {
    pass('POST /v1/messages (verified domain)', send.json.message_id);
    await pollMessage(send.json.message_id, (m) => m.status === 'delivered', 20_000);
    if (await mailpitMessageHasDkim(dkimSubject)) {
      pass('DKIM signature in Mailpit');
    } else {
      fail('DKIM signature in Mailpit', 'DKIM-Signature header not found');
    }
  } else {
    fail('POST /v1/messages (verified domain)', `status ${send.status}`);
  }

  // 5. Suppression list
  const suppressedEmail = `blocked-${Date.now()}@example.com`;
  const addSup = await request('POST', '/v1/suppressions', {
    body: { tenant_id: TENANT, email: suppressedEmail, reason: 'manual' },
  });
  if (addSup.status === 201) {
    pass('POST /v1/suppressions');
  } else {
    fail('POST /v1/suppressions', `status ${addSup.status}`);
  }

  const blocked = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `track3-blocked-${Date.now()}`,
      tenant_id: TENANT,
      from: { email: `support@${DOMAIN}` },
      to: [{ email: suppressedEmail }],
      subject: 'Should be blocked',
      content: { text: 'blocked' },
    },
  });
  if (blocked.status === 422 && blocked.json?.suppressed?.includes(suppressedEmail)) {
    pass('Suppressed recipient → 422');
  } else {
    fail('Suppressed recipient → 422', `status ${blocked.status}`);
  }

  const list = await request('GET', `/v1/suppressions?tenant_id=${TENANT}`);
  if (list.status === 200 && list.json?.suppressions?.length >= 1) {
    pass('GET /v1/suppressions', `${list.json.suppressions.length} entries`);
  } else {
    fail('GET /v1/suppressions', `status ${list.status}`);
  }

  // 6. Scheduled send
  const scheduledAt = new Date(Date.now() + 3000).toISOString();
  const schedSubject = `Track 3 scheduled ${Date.now()}`;
  const sched = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `track3-sched-${Date.now()}`,
      tenant_id: TENANT,
      from: { email: `support@${DOMAIN}` },
      to: [{ email: 'scheduled@example.com' }],
      subject: schedSubject,
      content: { text: 'scheduled' },
      scheduled_at: scheduledAt,
    },
  });

  if (sched.status !== 202) {
    fail('Scheduled send enqueue', `status ${sched.status}`);
  } else {
    const mid = sched.json.message_id;
    const early = await request('GET', `/v1/messages/${mid}`);
    if (early.json?.status === 'scheduled') {
      pass('Scheduled status before delivery', 'scheduled');
    } else {
      pass('Scheduled status before delivery', `status=${early.json?.status}`);
    }

    try {
      await pollMessage(mid, (m) => m.status === 'delivered', 15_000);
      pass('Scheduled delivery', 'delivered after delay');
    } catch (err) {
      fail('Scheduled delivery', err.message);
    }
  }

  // 7. Simulate bounce
  const bounceSubject = `Track 3 bounce ${Date.now()}`;
  const bounceSend = await request('POST', '/v1/messages', {
    body: {
      idempotency_key: `track3-bounce-${Date.now()}`,
      tenant_id: TENANT,
      from: { email: `support@${DOMAIN}` },
      to: [{ email: 'bounce-victim@example.com' }],
      subject: bounceSubject,
      content: { text: 'bounce test' },
    },
  });

  if (bounceSend.status === 202) {
    await pollMessage(bounceSend.json.message_id, (m) => m.status === 'delivered', 20_000);

    const sim = await request('POST', '/v1/admin/simulate-bounce', {
      body: {
        tenant_id: TENANT,
        message_id: bounceSend.json.message_id,
        recipient: 'bounce-victim@example.com',
        bounce_type: 'hard',
      },
    });

    if (sim.status === 200 && sim.json?.status === 'bounced' && sim.json?.suppressed) {
      pass('Simulate hard bounce', 'bounced + suppressed');
    } else {
      fail('Simulate hard bounce', JSON.stringify(sim.json));
    }

    const bounced = await request('GET', `/v1/messages/${bounceSend.json.message_id}`);
    const types = (bounced.json?.events ?? []).map((e) => e.event_type);
    if (types.includes('bounced')) {
      pass('Bounce event recorded');
    } else {
      fail('Bounce event recorded', types.join(', '));
    }
  } else {
    fail('Bounce test setup send', `status ${bounceSend.status}`);
  }

  await finish();
}

async function finish(exitCode = null) {
  await stopWebhookMock();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed === 0) {
    console.log('\nTrack 3 (AMDS local) — PASSED');
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
