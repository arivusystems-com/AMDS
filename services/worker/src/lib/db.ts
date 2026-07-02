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
  if (!pool) {
    return;
  }

  const activePool = pool;
  pool = null;

  await Promise.race([
    activePool.end(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 2_000);
    }),
  ]);
}
