import pg from 'pg';
import { loadConfig } from '@vmds/shared';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
