import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { route } from '../worker/routes';
import type { Env } from '../worker/http';

// Run the route SQL against real SQLite, rather than mocking query results.
let db: DatabaseSync;
let env: Env;
const at = '2026-10-01T00:00:00.000Z';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  const migrations = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  env = {
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
  } as unknown as Env;
  db.prepare(
    `INSERT INTO accounts (id,name,opening_balance_at,created_at,updated_at)
    VALUES ('test-account','Test',?,?,?)`
  ).run(at, at, at);
});

afterEach(() => db.close());

function transaction(id: string, deleted: boolean) {
  db.prepare(
    `INSERT INTO transactions
    (id,account_id,transaction_type,amount_minor,occurred_at,created_at,updated_at,deleted_at)
    VALUES (?,'test-account','expense',100,?,?,?,?)`
  ).run(id, at, at, at, deleted ? at : null);
}

async function request(path: string, method = 'GET') {
  const url = new URL(path, 'https://example.test');
  return route(new Request(url, { method }), url, env);
}

describe('fresh paged lists', () => {
  it('only lists deleted transactions and paginates timestamp ties without duplicates', async () => {
    transaction('live', false);
    for (const id of ['a', 'b', 'c']) transaction(id, true);
    const first = (await (await request('/api/trash?limit=2')).json()) as any[];
    expect(first.map((r) => r.id)).toEqual(['c', 'b']);
    const cursor = new URLSearchParams({
      limit: '2',
      before: at,
      beforeCreated: at,
      beforeId: 'b',
    });
    const next = (await (await request(`/api/trash?${cursor}`)).json()) as any[];
    expect(next.map((r) => r.id)).toEqual(['a']);
    const live = (await (await request('/api/transactions')).json()) as any[];
    expect(live.map((r) => r.id)).toEqual(['live']);
  });

  it('reaches Empty Trash, preserves live rows, and audits the deletion', async () => {
    transaction('live', false);
    transaction('deleted', true);
    const response = await request('/api/trash/purge', 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 1 });
    expect(db.prepare('SELECT id FROM transactions').all()).toEqual([{ id: 'live' }]);
    expect(db.prepare("SELECT action FROM audit_log WHERE entity_id='deleted'").get()).toEqual({
      action: 'delete',
    });
  });

  it('paginates audit ties while retaining filters and stripping historical file payloads', async () => {
    db.exec('DELETE FROM audit_log');
    const insert = db.prepare(`INSERT INTO audit_log
      (id,occurred_at,entity_type,entity_id,action,before_json,after_json) VALUES (?,?,?,'entity','update',?,?)`);
    const attachment = JSON.stringify({
      file_name: 'receipt.png',
      size_bytes: 1000000,
      external_file_id: 'data:image/png;base64,' + 'A'.repeat(1000000),
      url: 'data:duplicate',
    });
    insert.run('a', at, 'attachment', attachment, attachment);
    insert.run('b', at, 'attachment', null, attachment);
    insert.run('c', at, 'transaction', null, JSON.stringify({ amount_minor: 100 }));
    const first = (await (
      await request('/api/audit?entityType=attachment&limit=1')
    ).json()) as any[];
    expect(first.map((r) => r.id)).toEqual(['b']);
    expect(JSON.parse(first[0].after_json)).toEqual({
      file_name: 'receipt.png',
      size_bytes: 1000000,
    });
    const cursor = new URLSearchParams({
      entityType: 'attachment',
      limit: '1',
      before: at,
      beforeId: 'b',
    });
    const next = (await (await request(`/api/audit?${cursor}`)).json()) as any[];
    expect(next.map((r) => r.id)).toEqual(['a']);
    expect(JSON.stringify(next).length).toBeLessThan(1000);
    // Responses are slimmed; the stored historical record is not modified.
    expect(db.prepare("SELECT after_json FROM audit_log WHERE id='a'").get()?.after_json).toBe(
      attachment
    );
  });
});
