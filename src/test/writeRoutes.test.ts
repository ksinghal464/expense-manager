import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { route } from '../worker/routes';
import type { Env } from '../worker/http';
import { sqliteEnv } from './sqliteEnv';

// Save paths (create/update/delete transaction, create/update transfer) run against
// real SQLite: stored rows, audit entries, suggestions and the response's changed rows.
let db: DatabaseSync;
let env: Env;
let stats: { roundTrips: number };
const at = '2026-10-01T00:00:00.000Z';

beforeEach(() => {
  ({ db, env, stats } = sqliteEnv());
  const ins = (sql: string, ...v: unknown[]) => db.prepare(sql).run(...(v as any[]));
  // Start from empty master data (migration 0004 seeds defaults).
  db.exec(
    'DELETE FROM payment_methods; DELETE FROM accounts; DELETE FROM categories; DELETE FROM payees; DELETE FROM tags;'
  );
  for (const [id, name] of [
    ['A1', 'Bank'],
    ['A2', 'Cash'],
  ])
    ins(
      'INSERT INTO accounts (id,name,opening_balance_at,created_at,updated_at) VALUES (?,?,?,?,?)',
      id,
      name,
      at,
      at,
      at
    );
  ins(
    'INSERT INTO accounts (id,name,opening_balance_at,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)',
    'Adead',
    'Old',
    at,
    at,
    at,
    at
  );
  for (const [id, acc] of [
    ['M1', 'A1'],
    ['M2', 'A2'],
  ])
    ins(
      'INSERT INTO payment_methods (id,account_id,name,created_at,updated_at) VALUES (?,?,?,?,?)',
      id,
      acc,
      id,
      at,
      at
    );
  for (const [id, kind, dead] of [
    ['Cfood', 'expense', null],
    ['Csal', 'income', null],
    ['Cboth', 'both', null],
    ['Cdead', 'expense', at],
  ])
    ins(
      'INSERT INTO categories (id,name,kind,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?)',
      id,
      id.slice(1),
      kind,
      at,
      at,
      dead
    );
  ins("INSERT INTO payees (id,name,created_at,updated_at) VALUES ('P1','Swiggy',?,?)", at, at);
  ins("INSERT INTO tags (id,name,created_at,updated_at) VALUES ('T1','trip',?,?)", at, at);
});

afterEach(() => db.close());

async function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, 'https://example.test');
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  stats.roundTrips = 0;
  try {
    const res = await route(new Request(url, init), url, env);
    return { status: res.status, body: (await res.json()) as any, trips: stats.roundTrips };
  } catch (e: any) {
    return { status: e.status ?? 500, body: { error: e.message }, trips: stats.roundTrips };
  }
}

const expense = (over: Record<string, unknown> = {}) => ({
  type: 'expense',
  accountId: 'A1',
  methodId: 'M1',
  categoryId: 'Cfood',
  amount: 120.5,
  occurredAt: '2026-10-02T10:00:00.000Z',
  description: 'Lunch',
  note: 'n',
  status: 'cleared',
  payee: 'swiggy',
  tags: ['trip', 'Work'],
  ...over,
});

const row = (id: string) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as any;
const suggestion = (d: string) =>
  db.prepare('SELECT usage_count FROM description_suggestions WHERE description=?').get(d) as any;
const audits = (id: string) =>
  db
    .prepare(
      'SELECT action, before_json, after_json FROM audit_log WHERE entity_id=? ORDER BY rowid'
    )
    .all(id) as any[];
const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

describe('create transaction', () => {
  it('stores the row, payee, tags, suggestion and audit in few round trips', async () => {
    const r = await call('POST', '/api/transactions', expense());
    expect(r.status).toBe(201);
    const t = row(r.body.id);
    expect(t).toMatchObject({
      account_id: 'A1',
      payment_method_id: 'M1',
      category_id: 'Cfood',
      payee_id: 'P1', // matched case-insensitively
      transaction_type: 'expense',
      amount_minor: 12050,
      description: 'Lunch',
      is_split_parent: 0,
      deleted_at: null,
    });
    const tagNames = db
      .prepare(
        'SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id WHERE tt.transaction_id=? ORDER BY tg.name'
      )
      .all(r.body.id)
      .map((x: any) => x.name);
    expect(tagNames).toEqual(['Work', 'trip']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 2 });
    expect(suggestion('Lunch')).toEqual({ usage_count: 1 });
    const [a] = audits(r.body.id);
    expect(a.action).toBe('create');
    expect(a.before_json).toBeNull();
    // The audit snapshot is exactly the stored row (same columns, same order).
    expect(JSON.parse(a.after_json)).toEqual(t);
    expect(Object.keys(JSON.parse(a.after_json))).toEqual(Object.keys(t));
    // Response: the transaction itself plus the rows the client must refresh.
    expect(r.body).toMatchObject({ account_name: 'Bank', payee_name: 'Swiggy' });
    expect(r.body.tags.sort()).toEqual(['Work', 'trip']);
    expect(r.body.affected.map((x: any) => x.id)).toEqual([r.body.id]);
    expect(r.body.affected[0].tags.sort()).toEqual(['Work', 'trip']);
    expect(r.body.masterChanged).toBe(true); // new tag "Work"
    expect(r.trips).toBeLessThanOrEqual(2);
  });

  it('creates a new payee, reuses tags and bumps the suggestion on repeat', async () => {
    await call('POST', '/api/transactions', expense({ payee: '', tags: [] }));
    const r = await call('POST', '/api/transactions', expense({ payee: 'Zomato', tags: ['TRIP'] }));
    expect(r.status).toBe(201);
    const p = db.prepare("SELECT id FROM payees WHERE name='Zomato'").get() as any;
    expect(row(r.body.id).payee_id).toBe(p.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 1 });
    expect(suggestion('Lunch')).toEqual({ usage_count: 2 });
    expect(r.body.masterChanged).toBe(true);
    const again = await call(
      'POST',
      '/api/transactions',
      expense({ payee: 'zomato', tags: ['trip'] })
    );
    expect(again.body.masterChanged).toBe(false);
    expect(row(again.body.id).payee_id).toBe(p.id);
  });

  it('stores splits', async () => {
    const r = await call(
      'POST',
      '/api/transactions',
      expense({
        amount: 100,
        isSplitParent: true,
        splits: [
          { categoryId: 'Cfood', amount: 60, description: 'a' },
          { categoryId: 'Cboth', amount: 40, description: 'b' },
        ],
      })
    );
    expect(r.status).toBe(201);
    expect(row(r.body.id).is_split_parent).toBe(1);
    expect(
      db
        .prepare(
          'SELECT category_id, amount_minor FROM transaction_splits WHERE transaction_id=? ORDER BY amount_minor'
        )
        .all(r.body.id)
    ).toEqual([
      { category_id: 'Cboth', amount_minor: 4000 },
      { category_id: 'Cfood', amount_minor: 6000 },
    ]);
    const bad = await call(
      'POST',
      '/api/transactions',
      expense({
        amount: 100,
        isSplitParent: true,
        splits: [
          { categoryId: 'Cdead', amount: 60 },
          { categoryId: 'Cfood', amount: 40 },
        ],
      })
    );
    expect(bad).toMatchObject({ status: 400, body: { error: 'Split category not found' } });
  });

  it.each([
    [{ accountId: 'Adead' }, 'Account not found'],
    [{ accountId: 'nope' }, 'Account not found'],
    [{ categoryId: 'Cdead' }, 'Category not found'],
    [{ methodId: 'zzz' }, 'Payment method not found'],
    [{ methodId: 'M2' }, 'Payment method does not belong to the selected account'],
    [{ categoryId: 'Csal' }, 'Category is not valid for expense transactions'],
    [
      { refundsTransactionId: 'missing', type: 'income', categoryId: 'Csal' },
      'Refund target transaction not found',
    ],
  ])('rejects %o and writes nothing', async (over, error) => {
    const r = await call('POST', '/api/transactions', expense(over));
    expect(r).toMatchObject({ status: 400, body: { error } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE name='Work'").get()).toEqual({ n: 0 });
  });
});

describe('refunds', () => {
  it('returns the original expense and sibling refunds with updated totals', async () => {
    const e = await call('POST', '/api/transactions', expense({ amount: 100, tags: [] }));
    const refund = (amount: number) =>
      call('POST', '/api/transactions', {
        type: 'income',
        accountId: 'A1',
        methodId: 'M1',
        categoryId: 'Cboth',
        amount,
        description: 'Refund',
        refundsTransactionId: e.body.id,
      });
    const r1 = await refund(30);
    expect(byId(r1.body.affected)[e.body.id].refunded_minor).toBe(3000);
    const r2 = await refund(20);
    const aff = byId(r2.body.affected);
    expect(aff[e.body.id].refunded_minor).toBe(5000);
    expect(aff[r1.body.id].refund_siblings_total).toBe(5000);
    expect(aff[r2.body.id].refund_of_description).toBe('Lunch');

    const d = await call('DELETE', `/api/transactions/${r2.body.id}`);
    expect(d.body.removed).toEqual([r2.body.id]);
    expect(byId(d.body.affected)[e.body.id].refunded_minor).toBe(3000);
    expect(byId(d.body.affected)[r1.body.id].refund_siblings_total).toBe(3000);
    expect(d.trips).toBeLessThanOrEqual(3);
  });
});

describe('update transaction', () => {
  it('updates fields, splits, tags, suggestions and audit', async () => {
    const c = await call('POST', '/api/transactions', expense({ amount: 100 }));
    const u = await call(
      'PUT',
      `/api/transactions/${c.body.id}`,
      expense({
        amount: 90,
        description: 'Dinner',
        accountId: 'A2',
        methodId: 'M2',
        payee: 'New Place',
        tags: ['Work'],
        splits: [
          { categoryId: 'Cfood', amount: 50, description: 'x' },
          { categoryId: 'Cboth', amount: 40, description: 'y' },
        ],
      })
    );
    expect(u.status).toBe(200);
    const t = row(c.body.id);
    expect(t).toMatchObject({
      account_id: 'A2',
      payment_method_id: 'M2',
      amount_minor: 9000,
      description: 'Dinner',
      is_split_parent: 1,
    });
    expect(suggestion('Lunch')).toBeUndefined(); // no longer used anywhere
    expect(suggestion('Dinner')).toEqual({ usage_count: 1 });
    const upd = audits(c.body.id)[1];
    expect(upd.action).toBe('update');
    const after = JSON.parse(upd.after_json);
    const { splits_summary, ...afterRow } = after;
    expect(afterRow).toEqual(t);
    expect(splits_summary).toEqual([
      {
        category_id: 'Cfood',
        category_name: 'food',
        amount_minor: 5000,
        description: 'x',
        occurred_at: t.occurred_at,
      },
      {
        category_id: 'Cboth',
        category_name: 'both',
        amount_minor: 4000,
        description: 'y',
        occurred_at: t.occurred_at,
      },
    ]);
    expect(JSON.parse(upd.before_json)).toMatchObject({ description: 'Lunch', splits_summary: [] });
    expect(u.body).toMatchObject({
      id: c.body.id,
      account_name: 'Cash',
      payee_name: 'New Place',
      tags: ['Work'],
    });
    expect(u.body.affected.map((x: any) => x.id)).toEqual([c.body.id]);
    expect(u.body.masterChanged).toBe(true);
    expect(u.trips).toBeLessThanOrEqual(3);

    // dropping back to no splits clears them
    const u2 = await call(
      'PUT',
      `/api/transactions/${c.body.id}`,
      expense({ amount: 90, splits: [] })
    );
    expect(u2.status).toBe(200);
    expect(row(c.body.id).is_split_parent).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transaction_splits').get()).toEqual({ n: 0 });
  });

  it('rejects bad edits without writing', async () => {
    const c = await call('POST', '/api/transactions', expense());
    const before = row(c.body.id);
    const r = await call('PUT', `/api/transactions/${c.body.id}`, expense({ methodId: 'M2' }));
    expect(r).toMatchObject({
      status: 400,
      body: { error: 'Payment method does not belong to the selected account' },
    });
    expect(row(c.body.id)).toEqual(before);
    expect(await call('PUT', '/api/transactions/nope', expense())).toMatchObject({ status: 404 });
    const self = await call(
      'PUT',
      `/api/transactions/${c.body.id}`,
      expense({ type: 'income', categoryId: 'Cboth', refundsTransactionId: c.body.id })
    );
    expect(self).toMatchObject({
      status: 400,
      body: { error: 'A transaction cannot refund itself' },
    });
  });
});

describe('partial edits', () => {
  it('validates omitted fields against the stored row', async () => {
    const c = await call('POST', '/api/transactions', expense({ tags: ['Work', 'work'] }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE lower(name)='work'").get()).toEqual({
      n: 1,
    });
    const u = await call('PUT', `/api/transactions/${c.body.id}`, { description: 'Only this' });
    expect(u.status).toBe(200);
    expect(row(c.body.id)).toMatchObject({
      description: 'Only this',
      account_id: 'A1',
      payment_method_id: 'M1',
      category_id: 'Cfood',
      payee_id: 'P1',
    });
    expect(u.body.tags).toEqual(['Work']); // tags untouched when omitted
    // Only the method changes: checked against the stored account.
    const bad = await call('PUT', `/api/transactions/${c.body.id}`, { methodId: 'M2' });
    expect(bad.body.error).toBe('Payment method does not belong to the selected account');
    // Only the type changes: checked against the stored category.
    const kind = await call('PUT', `/api/transactions/${c.body.id}`, { type: 'income' });
    expect(kind.body.error).toBe('Category is not valid for income transactions');
    // Clearing the payee.
    await call('PUT', `/api/transactions/${c.body.id}`, { payee: '' });
    expect(row(c.body.id).payee_id).toBeNull();
  });

  it('keeps and re-checks a stored refund link, and clears it on null', async () => {
    const e = await call('POST', '/api/transactions', expense({ amount: 100, tags: [] }));
    const r = await call('POST', '/api/transactions', {
      type: 'income',
      accountId: 'A1',
      methodId: 'M1',
      categoryId: 'Cboth',
      amount: 10,
      refundsTransactionId: e.body.id,
    });
    const u = await call('PUT', `/api/transactions/${r.body.id}`, { amount: 15 });
    expect(u.status).toBe(200);
    expect(row(r.body.id).refunds_transaction_id).toBe(e.body.id);
    expect(byId(u.body.affected)[e.body.id].refunded_minor).toBe(1500);
    const asExpense = await call('PUT', `/api/transactions/${r.body.id}`, { type: 'expense' });
    expect(asExpense.body.error).toBe('A refund must be recorded as income');
    const cleared = await call('PUT', `/api/transactions/${r.body.id}`, {
      refundsTransactionId: null,
    });
    expect(row(r.body.id).refunds_transaction_id).toBeNull();
    // The old parent is returned so the client drops its "refunded" amount.
    expect(byId(cleared.body.affected)[e.body.id].refunded_minor).toBe(0);
  });

  it('accepts an explicit payeeId', async () => {
    const c = await call('POST', '/api/transactions', expense({ payee: undefined, payeeId: 'P1' }));
    expect(row(c.body.id).payee_id).toBe('P1');
    expect(c.body.masterChanged).toBe(true); // tag "Work" is new
  });
});

describe('delete transaction', () => {
  it('soft-deletes, un-feeds the suggestion and audits', async () => {
    const c = await call('POST', '/api/transactions', expense());
    const live = row(c.body.id);
    const d = await call('DELETE', `/api/transactions/${c.body.id}`);
    expect(d.body).toMatchObject({ ok: true, removed: [c.body.id], affected: [] });
    expect(row(c.body.id).deleted_at).not.toBeNull();
    expect(suggestion('Lunch')).toBeUndefined();
    const del = audits(c.body.id)[1];
    expect(del.action).toBe('delete');
    // Snapshot is the live row plus deleted_at (updated_at as before, like the original code).
    expect(JSON.parse(del.after_json)).toEqual({ ...live, deleted_at: row(c.body.id).deleted_at });
    expect((await call('DELETE', `/api/transactions/${c.body.id}`)).status).toBe(404);
  });
});

describe('transfers', () => {
  it('creates, edits and deletes both legs together', async () => {
    const c = await call('POST', '/api/transfers', {
      fromAccountId: 'A1',
      toAccountId: 'A2',
      fromMethodId: 'M1',
      toMethodId: 'M2',
      amount: 500,
      occurredAt: '2026-10-03T00:00:00.000Z',
      note: 'move',
    });
    expect(c.status).toBe(201);
    expect(c.trips).toBeLessThanOrEqual(2);
    const legs = byId(c.body.affected);
    const out = c.body.affected.find((x: any) => x.transaction_type === 'expense');
    const inn = c.body.affected.find((x: any) => x.transaction_type === 'income');
    expect(Object.keys(legs)).toHaveLength(2);
    expect(out).toMatchObject({
      account_id: 'A1',
      description: 'Transfer to Cash',
      transfer_counterpart_account_name: 'Cash',
    });
    expect(inn).toMatchObject({ account_id: 'A2', description: 'Transfer from Bank' });
    expect(c.body).toMatchObject({ id: out.transfer_id, amount_minor: 50000 });
    expect(audits(c.body.id)[0].action).toBe('create');

    const bad = await call('POST', '/api/transfers', {
      fromAccountId: 'A1',
      toAccountId: 'A2',
      fromMethodId: 'M2',
      amount: 1,
    });
    expect(bad).toMatchObject({
      status: 400,
      body: { error: 'Payment method does not belong to the selected account' },
    });
    expect(
      (
        await call('POST', '/api/transfers', {
          fromAccountId: 'A1',
          toAccountId: 'Adead',
          amount: 1,
        })
      ).body
    ).toEqual({ error: 'To account not found' });

    const u = await call('PUT', `/api/transfers/${c.body.id}`, {
      amount: 250,
      description: 'Rent pot',
      toMethodId: '',
    });
    expect(u.status).toBe(200);
    expect(u.trips).toBeLessThanOrEqual(3);
    expect(row(out.id)).toMatchObject({ amount_minor: 25000, description: 'Rent pot' });
    expect(row(inn.id)).toMatchObject({ amount_minor: 25000, payment_method_id: null });
    expect(byId(u.body.affected)[inn.id].amount_minor).toBe(25000);
    expect(JSON.parse(audits(c.body.id)[1].after_json)).toMatchObject({
      amount_minor: 25000,
      description: 'Rent pot',
    });

    const d = await call('DELETE', `/api/transactions/${inn.id}`);
    expect(d.body.removed.sort()).toEqual([inn.id, out.id].sort());
    expect(row(out.id).deleted_at).not.toBeNull();
    expect(
      (db.prepare('SELECT deleted_at FROM transfers WHERE id=?').get(c.body.id) as any).deleted_at
    ).not.toBeNull();
    expect(audits(out.id).map((a) => a.action)).toEqual(['delete']);
  });
});
