#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(__dirname, '../migrations/001_init.sql'), 'utf8');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.log('Migration 001_init.sql applied successfully');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await client.end();
}
