import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

let loaded = false;

/** Load `.env` from the repo root (walks up from cwd). Idempotent. */
export function loadEnv(): void {
  if (loaded) {
    return;
  }
  const envPath = findEnvFile(process.cwd());
  if (envPath) {
    dotenv.config({ path: envPath });
  }
  loaded = true;
}
