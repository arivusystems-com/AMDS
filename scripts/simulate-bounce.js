#!/usr/bin/env node
/**
 * Simulate a bounce for a delivered message (local dev / validation).
 * Usage: node scripts/simulate-bounce.js <message_id> [tenant_id] [hard|soft]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const BASE_URL = process.env.AMDS_BASE_URL || `http://localhost:${process.env.AMDS_PORT || 8080}`;
const API_KEY = process.env.AMDS_API_KEY;

const messageId = process.argv[2];
const tenantId = process.argv[3] || 'org_local';
const bounceType = process.argv[4] === 'soft' ? 'soft' : 'hard';

if (!messageId || !API_KEY) {
  console.error('Usage: node scripts/simulate-bounce.js <message_id> [tenant_id] [hard|soft]');
  process.exit(1);
}

const response = await fetch(`${BASE_URL}/v1/admin/simulate-bounce`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tenant_id: tenantId,
    message_id: messageId,
    bounce_type: bounceType,
  }),
});

const json = await response.json();
console.log(JSON.stringify(json, null, 2));
process.exit(response.ok ? 0 : 1);
