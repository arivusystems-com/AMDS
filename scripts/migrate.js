#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../migrations');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const applied = await client.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (applied.rows.length > 0) {
      console.log(`Skip ${file} (already applied)`);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  console.log('Migrations complete');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await client.end();
}
