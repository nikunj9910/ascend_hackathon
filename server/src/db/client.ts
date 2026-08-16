import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'engine.db');

let db: Database.Database | undefined;

/**
 * Returns the process-wide SQLite connection, creating the DB file and its
 * parent directory on first access. Schema application is the responsibility
 * of db/setup.ts (run explicitly via `npm run db:setup` or `npm run seed`,
 * and automatically once on server boot) — this function only opens the
 * connection and sets pragmas.
 */
export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH
    ? path.resolve(process.cwd(), process.env.DATABASE_PATH)
    : DEFAULT_DB_PATH;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
