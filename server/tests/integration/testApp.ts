import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

export const TEST_API_KEY = 'test-api-key';

/**
 * Boots the real Express app (server/src/index.ts) against a fresh
 * throwaway SQLite file. Uses a dynamic import so DATABASE_PATH is set
 * BEFORE the app module's top-level setupDatabase() call runs — a static
 * import would be hoisted ahead of the env var assignment.
 */
export async function createTestApp(): Promise<{ app: Express; dbPath: string; cleanup: () => void }> {
  const dbPath = path.join(os.tmpdir(), `conflict-engine-test-${randomUUID()}.db`);
  process.env.DATABASE_PATH = dbPath;
  process.env.API_KEY = TEST_API_KEY;
  process.env.CORS_ORIGIN = 'http://localhost:5173';

  const mod = await import('../../src/index');
  const { closeDb } = await import('../../src/db/client');

  return {
    app: mod.default,
    dbPath,
    cleanup: () => {
      closeDb();
      for (const suffix of ['', '-wal', '-shm']) {
        const p = dbPath + suffix;
        if (fs.existsSync(p)) fs.rmSync(p);
      }
    },
  };
}
