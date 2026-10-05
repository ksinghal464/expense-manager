import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Env } from '../worker/http';

/**
 * In-memory SQLite with every migration applied, wrapped in the subset of the
 * D1 API the worker uses, so route SQL runs for real instead of being mocked.
 */
export function sqliteEnv(extra: Partial<Env> = {}): { db: DatabaseSync; env: Env } {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        let args: any[] = [];
        return {
          bind(...values: any[]) {
            args = values;
            return this;
          },
          async all() {
            return { results: statement.all(...args) };
          },
          async first() {
            return statement.get(...args) ?? null;
          },
          async run() {
            return statement.run(...args);
          },
        };
      },
    },
    ...extra,
  } as unknown as Env;
  return { db, env };
}
