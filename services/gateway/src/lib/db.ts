import pg from 'pg';
import { loadConfig } from '@vmds/shared';

let pool: pg.Pool | null = null;
let readPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  }
  return pool;
}

/** Optional read replica for read-heavy queries (reputation history). Falls back to primary. */
export function getReadPool(): pg.Pool {
  if (!readPool) {
    const config = loadConfig();
    readPool = new pg.Pool({
      connectionString: config.DATABASE_READ_URL ?? config.DATABASE_URL,
    });
  }
  return readPool;
}

export async function closePool(): Promise<void> {
  const pools = [pool, readPool].filter(Boolean) as pg.Pool[];
  pool = null;
  readPool = null;

  await Promise.all(
    pools.map((activePool) =>
      Promise.race([
        activePool.end(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        }),
      ])
    )
  );
}
