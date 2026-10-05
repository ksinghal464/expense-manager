import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Env } from '../worker/http';

/**
 * In-memory SQLite with every migration applied, wrapped in the subset of the
 * D1 API the worker uses, so route SQL runs for real instead of being mocked.
 * `stats.roundTrips` counts calls that would each be one network round trip
 * to D1 (first/all/run on a statement, or one whole batch).
 */
export function sqliteEnv(extra: Partial<Env> = {}): {
  db: DatabaseSync;
  env: Env;
  stats: { roundTrips: number };
} {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  const stats = { roundTrips: 0 };
  const env = {
    DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        let args: any[] = [];
        const exec = () =>
          statement.columns().length
            ? { results: statement.all(...args), meta: { changes: 0 } }
            : { results: [], meta: { changes: Number(statement.run(...args).changes) } };
        return {
          bind(...values: any[]) {
            args = values;
            return this;
          },
          async all() {
            stats.roundTrips++;
            return { results: statement.all(...args) };
          },
          async first() {
            stats.roundTrips++;
            return statement.get(...args) ?? null;
          },
          async run() {
            stats.roundTrips++;
            const r = statement.run(...args);
            return { ...r, meta: { changes: Number(r.changes) } };
          },
          _exec: exec,
        };
      },
      // Like D1: statements run in order inside one transaction; any failure rolls back all.
      async batch(stmts: { _exec: () => unknown }[]) {
        stats.roundTrips++;
        db.exec('BEGIN');
        try {
          const out = stmts.map((s) => s._exec());
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    ...extra,
  } as unknown as Env;
  return { db, env, stats };
}
