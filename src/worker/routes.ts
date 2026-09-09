import { Env, HttpError, json, textBody, readJson, readBody, corsHeaders } from './http';
import { now, id, audit, exists, getEntity, toIso, toMinorStrict, clampInt } from './db';
import { buildDashboard, rangeStats, categoryBreakdown } from './aggregate';
import { runRecurring, advanceDue } from './recurring';
import { importCsv, exportCsv, exportJson, restoreBackup } from './io';
import {
  driveAuthUrl,
  driveBackup,
  driveDisconnect,
  driveHandleCallback,
  driveRestore,
  driveSetAutoBackup,
  driveStatus,
} from './drive';

type Row = Record<string, any>;

const TYPE_RE = /^(expense|income)$/;
const STATUS_RE = /^(cleared|uncleared)$/;
const FREQ_RE = /^(daily|weekly|monthly|yearly)$/;

export const INSERT_TX = `INSERT INTO transactions
  (id,account_id,payment_method_id,category_id,payee_id,transaction_type,amount_minor,occurred_at,
   description,note,status,refunds_transaction_id,
   parent_transaction_id,recurring_rule_id,is_split_parent,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const TX_SELECT = `SELECT t.*, a.name AS account_name, c.name AS category_name, p.name AS payee_name,
  pm.name AS payment_method_name, parent.description AS refund_of_description,
  parent.occurred_at AS refund_of_occurred_at, parent.amount_minor AS refund_of_amount_minor,
  (SELECT COALESCE(SUM(r.amount_minor),0) FROM transactions r
    WHERE r.refunds_transaction_id=t.id AND r.deleted_at IS NULL) AS refunded_minor,
  (SELECT COALESCE(SUM(r2.amount_minor),0) FROM transactions r2
    WHERE r2.refunds_transaction_id=t.refunds_transaction_id AND r2.deleted_at IS NULL) AS refund_siblings_total
  FROM transactions t
  JOIN accounts a ON a.id=t.account_id
  LEFT JOIN categories c ON c.id=t.category_id
  LEFT JOIN payees p ON p.id=t.payee_id
  LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id
  LEFT JOIN transactions parent ON parent.id=t.refunds_transaction_id`;

function str(b: Record<string, unknown>, k: string): string {
  const v = b[k];
  return v == null ? '' : String(v).trim();
}
function optStr(b: Record<string, unknown>, k: string): string | null {
  const v = b[k];
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return String(v).trim();
}

async function upsertPayee(env: Env, name: string, at: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  const r = await env.DB.prepare(
    'SELECT id FROM payees WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1'
  )
    .bind(n.toLowerCase())
    .first<Row>();
  if (r) return r.id;
  const newId = id();
  await env.DB.prepare(
    'INSERT INTO payees (id,name,address,is_active,created_at,updated_at) VALUES (?,?,?,1,?,?)'
  )
    .bind(newId, n, '', at, at)
    .run();
  return newId;
}

async function upsertTag(env: Env, name: string, at: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  const r = await env.DB.prepare(
    'SELECT id FROM tags WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1'
  )
    .bind(n.toLowerCase())
    .first<Row>();
  if (r) return r.id;
  const newId = id();
  await env.DB.prepare('INSERT INTO tags (id,name,created_at,updated_at) VALUES (?,?,?,?)')
    .bind(newId, n, at, at)
    .run();
  return newId;
}

async function tagsFor(env: Env, txId: string): Promise<string[]> {
  const r = await env.DB.prepare(
    'SELECT tg.name FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id WHERE tt.transaction_id=?'
  )
    .bind(txId)
    .all<Row>();
  return r.results.map((x) => x.name);
}

async function tagsForMany(env: Env, txIds: string[]): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {};
  if (!txIds.length) return map;
  const ph = txIds.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT tt.transaction_id AS tid, tg.name FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id
     WHERE tt.transaction_id IN (${ph})`
  )
    .bind(...txIds)
    .all<Row>();
  for (const x of r.results) (map[x.tid] ||= []).push(x.name);
  return map;
}

async function txBase(env: Env, txId: string): Promise<Row | null> {
  return env.DB.prepare(`${TX_SELECT} WHERE t.id=?`).bind(txId).first<Row>();
}

async function txDetail(env: Env, txId: string): Promise<Row | null> {
  const t = await txBase(env, txId);
  if (!t) return null;
  const [splits, refunds, tags] = await Promise.all([
    env.DB.prepare(
      `SELECT s.*, c.name AS category_name FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id
       WHERE s.transaction_id=? AND s.deleted_at IS NULL ORDER BY s.created_at`
    )
      .bind(txId)
      .all<Row>(),
    env.DB.prepare(
      `SELECT r.id, r.occurred_at, r.amount_minor, r.description, r.account_id, a.name AS account_name
       FROM transactions r JOIN accounts a ON a.id=r.account_id
       WHERE r.refunds_transaction_id=? AND r.deleted_at IS NULL ORDER BY r.occurred_at`
    )
      .bind(txId)
      .all<Row>(),
    tagsFor(env, txId),
  ]);
  return {
    ...t,
    splits: splits.results,
    refunds: refunds.results,
    tags,
  };
}

async function listTransactions(env: Env, url: URL): Promise<Response> {
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type');
  const account = url.searchParams.get('account');
  const category = url.searchParams.get('category');
  const method = url.searchParams.get('method');
  const status = url.searchParams.get('status');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const includeDeleted = url.searchParams.get('deleted') === '1';

  const clauses = [includeDeleted ? '1=1' : 't.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (q) {
    const s = `%${q}%`;
    clauses.push(
      `(LOWER(t.description) LIKE LOWER(?) OR LOWER(t.note) LIKE LOWER(?) OR LOWER(COALESCE(c.name,'')) LIKE LOWER(?)
        OR LOWER(COALESCE(p.name,'')) LIKE LOWER(?) OR LOWER(a.name) LIKE LOWER(?)
        OR LOWER(COALESCE(pm.name,'')) LIKE LOWER(?))`
    );
    params.push(s, s, s, s, s, s);
  }
  if (type === 'income' || type === 'expense') {
    clauses.push('t.transaction_type=?');
    params.push(type);
  }
  if (account) {
    clauses.push('t.account_id=?');
    params.push(account);
  }
  if (category) {
    clauses.push('t.category_id=?');
    params.push(category);
  }
  if (method) {
    clauses.push('t.payment_method_id=?');
    params.push(method);
  }
  if (status === 'cleared' || status === 'uncleared') {
    clauses.push('t.status=?');
    params.push(status);
  }
  if (from) {
    clauses.push('t.occurred_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('t.occurred_at <= ?');
    params.push(to);
  }

  const r = await env.DB.prepare(
    `${TX_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<Row>();
  const tags = await tagsForMany(
    env,
    r.results.map((x) => x.id)
  );
  return json(r.results.map((t) => ({ ...t, tags: tags[t.id] || [] })));
}

async function createTransaction(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const at = now();
  const accountId = str(b, 'accountId');
  const type = str(b, 'type');
  const amountMinor = toMinorStrict(b['amount']);
  if (!accountId) throw new HttpError(400, 'accountId is required');
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'type must be expense or income');
  if (!(amountMinor > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const acc = await env.DB.prepare('SELECT 1 AS ok FROM accounts WHERE id=? AND deleted_at IS NULL')
    .bind(accountId)
    .first<Row>();
  if (!acc) throw new HttpError(400, 'Account not found');

  const categoryId = optStr(b, 'categoryId');
  const methodId = optStr(b, 'methodId');
  if (!categoryId) throw new HttpError(400, 'categoryId is required');
  if (!methodId) throw new HttpError(400, 'methodId is required');
  if (!(await exists(env, 'categories', categoryId)))
    throw new HttpError(400, 'Category not found');
  if (!(await exists(env, 'payment_methods', methodId)))
    throw new HttpError(400, 'Payment method not found');

  const refundsTransactionId = optStr(b, 'refundsTransactionId');
  if (refundsTransactionId) {
    const ref = await env.DB.prepare(
      'SELECT transaction_type FROM transactions WHERE id=? AND deleted_at IS NULL'
    )
      .bind(refundsTransactionId)
      .first<Row>();
    if (!ref) throw new HttpError(400, 'Refund target transaction not found');
    if (ref.transaction_type !== 'expense')
      throw new HttpError(400, 'Refund target must be an expense');
    if (type !== 'income') throw new HttpError(400, 'A refund must be recorded as income');
  }

  let payeeId = optStr(b, 'payeeId');
  const payeeName = str(b, 'payee');
  if (!payeeId && payeeName) payeeId = await upsertPayee(env, payeeName, at);

  const status = STATUS_RE.test(str(b, 'status')) ? str(b, 'status') : 'cleared';
  const description = str(b, 'description');
  const note = str(b, 'note');
  const occurredAt = toIso(b['occurredAt']);

  const txId = id();
  const isSplitParent = b['isSplitParent'] === true;
  const splitsRaw = Array.isArray(b['splits']) ? (b['splits'] as any[]) : [];

  if (isSplitParent) {
    if (splitsRaw.length < 2) throw new HttpError(400, 'A split needs at least two items');
    let sum = 0;
    const prepared = splitsRaw.map((s) => {
      const amt = toMinorStrict(s.amount);
      if (!(amt > 0)) throw new HttpError(400, 'Each split amount must be greater than zero');
      sum += amt;
      const catId = optStr(s, 'categoryId');
      return {
        id: id(),
        categoryId: catId,
        amount: amt,
        description: str(s, 'description'),
        note: str(s, 'note'),
        occurredAt: optStr(s, 'occurredAt') ? toIso(s.occurredAt) : occurredAt,
      };
    });
    for (const s of prepared)
      if (s.categoryId && !(await exists(env, 'categories', s.categoryId)))
        throw new HttpError(400, 'Split category not found');
    if (Math.abs(sum - amountMinor) > 1)
      throw new HttpError(400, 'Split amounts must sum to the total');
    await env.DB.prepare(INSERT_TX)
      .bind(
        txId,
        accountId,
        methodId,
        categoryId,
        payeeId,
        type,
        amountMinor,
        occurredAt,
        description,
        note,
        status,
        refundsTransactionId,
        null,
        null,
        1,
        at,
        at
      )
      .run();
    await env.DB.batch(
      prepared.map((s) =>
        env.DB.prepare(
          'INSERT INTO transaction_splits (id,transaction_id,category_id,amount_minor,description,note,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        ).bind(s.id, txId, s.categoryId, s.amount, s.description, s.note, s.occurredAt, at, at)
      )
    );
  } else {
    await env.DB.prepare(INSERT_TX)
      .bind(
        txId,
        accountId,
        methodId,
        categoryId,
        payeeId,
        type,
        amountMinor,
        occurredAt,
        description,
        note,
        status,
        refundsTransactionId,
        null,
        null,
        0,
        at,
        at
      )
      .run();
  }

  const tagNames = Array.isArray(b['tags'])
    ? (b['tags'] as any[]).map((t) => String(t).trim()).filter(Boolean)
    : [];
  const tagIds: string[] = [];
  for (const t of new Set(tagNames)) {
    const tid = await upsertTag(env, t, at);
    if (tid) tagIds.push(tid);
  }
  if (tagIds.length) {
    await env.DB.batch(
      tagIds.map((tid) =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)'
        ).bind(txId, tid)
      )
    );
  }

  if (description) {
    const ex = await env.DB.prepare(
      'SELECT id FROM description_suggestions WHERE lower(description)=lower(?)'
    )
      .bind(description)
      .first<Row>();
    if (ex)
      await env.DB.prepare(
        'UPDATE description_suggestions SET usage_count=usage_count+1, last_used_at=?, updated_at=? WHERE id=?'
      )
        .bind(at, at, ex.id)
        .run();
    else
      await env.DB.prepare(
        'INSERT INTO description_suggestions (id,description,usage_count,last_used_at,created_at,updated_at) VALUES (?,?,1,?,?,?)'
      )
        .bind(id(), description, at, at, at)
        .run();
  }

  const created = await env.DB.prepare('SELECT * FROM transactions WHERE id=?')
    .bind(txId)
    .first<Row>();
  await audit(env, 'transaction', txId, 'create', null, created);
  const detail = await txDetail(env, txId);
  return json(detail, { status: 201 });
}

async function updateTransaction(env: Env, request: Request, txId: string): Promise<Response> {
  const before = await env.DB.prepare(
    'SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL'
  )
    .bind(txId)
    .first<Row>();
  if (!before) throw new HttpError(404, 'Transaction not found');
  const b = await readJson(request);
  const at = now();

  const amountMinor = b['amount'] !== undefined ? toMinorStrict(b['amount']) : before.amount_minor;
  const type = b['type'] !== undefined ? String(b['type']) : before.transaction_type;
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'type must be expense or income');
  if (!(amountMinor > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const accountId = b['accountId'] !== undefined ? String(b['accountId']) : before.account_id;
  if (!(await exists(env, 'accounts', accountId))) throw new HttpError(400, 'Account not found');
  const methodId =
    b['methodId'] !== undefined ? String(b['methodId'] || '') : before.payment_method_id;
  const categoryId =
    b['categoryId'] !== undefined ? String(b['categoryId'] || '') : before.category_id;
  if (!methodId) throw new HttpError(400, 'methodId is required');
  if (!categoryId) throw new HttpError(400, 'categoryId is required');
  if (!(await exists(env, 'payment_methods', methodId)))
    throw new HttpError(400, 'Payment method not found');
  if (!(await exists(env, 'categories', categoryId)))
    throw new HttpError(400, 'Category not found');

  let payeeId =
    b['payeeId'] === null
      ? null
      : b['payeeId'] !== undefined
        ? String(b['payeeId'])
        : before.payee_id;
  if (b['payee'] !== undefined) payeeId = await upsertPayee(env, str(b, 'payee'), at);

  const status =
    b['status'] !== undefined
      ? STATUS_RE.test(String(b['status']))
        ? String(b['status'])
        : 'cleared'
      : before.status;
  const description =
    b['description'] !== undefined ? String(b['description']) : before.description;
  const note = b['note'] !== undefined ? String(b['note']) : before.note;
  const occurredAt = b['occurredAt'] !== undefined ? toIso(b['occurredAt']) : before.occurred_at;

  await env.DB.prepare(
    `UPDATE transactions SET account_id=?,payment_method_id=?,category_id=?,payee_id=?,transaction_type=?,amount_minor=?,
     occurred_at=?,description=?,note=?,status=?,updated_at=?
     WHERE id=?`
  )
    .bind(
      accountId,
      methodId,
      categoryId,
      payeeId,
      type,
      amountMinor,
      occurredAt,
      description,
      note,
      status,
      at,
      txId
    )
    .run();

  // replace splits if provided
  let splitsBefore: Row[] | null = null;
  let splitsAfter: Row[] | null = null;
  if (Array.isArray(b['splits'])) {
    const splitsRaw = b['splits'] as any[];
    const oldSplits = await env.DB.prepare(
      `SELECT s.*, c.name AS category_name FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id
       WHERE s.transaction_id=? AND s.deleted_at IS NULL ORDER BY s.created_at`
    )
      .bind(txId)
      .all<Row>();
    splitsBefore = oldSplits.results;
    await env.DB.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').bind(txId).run();
    let isSplitParent = 0;
    if (splitsRaw.length >= 2) {
      let sum = 0;
      const prepared = splitsRaw.map((s) => {
        const amt = toMinorStrict(s.amount);
        if (!(amt > 0)) throw new HttpError(400, 'Each split amount must be greater than zero');
        sum += amt;
        return {
          id: id(),
          categoryId: optStr(s, 'categoryId'),
          amount: amt,
          description: str(s, 'description'),
          note: str(s, 'note'),
          occurredAt: optStr(s, 'occurredAt') ? toIso(s.occurredAt) : occurredAt,
        };
      });
      if (Math.abs(sum - amountMinor) > 1)
        throw new HttpError(400, 'Split amounts must sum to the total');
      await env.DB.batch(
        prepared.map((s) =>
          env.DB.prepare(
            'INSERT INTO transaction_splits (id,transaction_id,category_id,amount_minor,description,note,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(s.id, txId, s.categoryId, s.amount, s.description, s.note, s.occurredAt, at, at)
        )
      );
      isSplitParent = 1;
      const catNames = new Map(
        (await env.DB.prepare('SELECT id,name FROM categories').all<Row>()).results.map((c) => [
          c.id,
          c.name,
        ])
      );
      splitsAfter = prepared.map((s) => ({
        category_id: s.categoryId,
        category_name: s.categoryId ? catNames.get(s.categoryId) || null : null,
        amount_minor: s.amount,
        description: s.description,
        occurred_at: s.occurredAt,
      }));
    } else {
      splitsAfter = [];
    }
    await env.DB.prepare('UPDATE transactions SET is_split_parent=? WHERE id=?')
      .bind(isSplitParent, txId)
      .run();
  }

  // replace tags if provided
  if (Array.isArray(b['tags'])) {
    await env.DB.prepare('DELETE FROM transaction_tags WHERE transaction_id=?').bind(txId).run();
    const tagIds: string[] = [];
    for (const t of new Set((b['tags'] as any[]).map((x) => String(x).trim()).filter(Boolean))) {
      const tid = await upsertTag(env, t, at);
      if (tid) tagIds.push(tid);
    }
    if (tagIds.length)
      await env.DB.batch(
        tagIds.map((tid) =>
          env.DB.prepare(
            'INSERT OR IGNORE INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)'
          ).bind(txId, tid)
        )
      );
  }

  if (description) {
    const ex = await env.DB.prepare(
      'SELECT id FROM description_suggestions WHERE lower(description)=lower(?)'
    )
      .bind(description)
      .first<Row>();
    if (ex)
      await env.DB.prepare(
        'UPDATE description_suggestions SET usage_count=usage_count+1, last_used_at=?, updated_at=? WHERE id=?'
      )
        .bind(at, at, ex.id)
        .run();
    else
      await env.DB.prepare(
        'INSERT INTO description_suggestions (id,description,usage_count,last_used_at,created_at,updated_at) VALUES (?,?,1,?,?,?)'
      )
        .bind(id(), description, at, at, at)
        .run();
  }

  const after: Row = (await env.DB.prepare('SELECT * FROM transactions WHERE id=?')
    .bind(txId)
    .first<Row>())!;
  const auditBefore: Row = splitsBefore ? { ...before, splits_summary: splitsBefore } : before;
  const auditAfter: Row = splitsAfter ? { ...after, splits_summary: splitsAfter } : after;
  await audit(env, 'transaction', txId, 'update', auditBefore, auditAfter);
  return json(await txDetail(env, txId));
}

async function deleteTransaction(env: Env, txId: string, hard: boolean): Promise<Response> {
  const before = await env.DB.prepare(
    'SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL'
  )
    .bind(txId)
    .first<Row>();
  if (!before) throw new HttpError(404, 'Transaction not found');
  const at = now();
  if (!hard) {
    await env.DB.prepare('UPDATE transactions SET deleted_at=?, updated_at=? WHERE id=?')
      .bind(at, at, txId)
      .run();
    await audit(env, 'transaction', txId, 'delete', before, { ...before, deleted_at: at });
    return json({ ok: true });
  }
  // hard delete + dependents; unlink any refunds pointing here
  await env.DB.prepare(
    'UPDATE transactions SET refunds_transaction_id=NULL WHERE refunds_transaction_id=?'
  )
    .bind(txId)
    .run();
  await env.DB.prepare('DELETE FROM transaction_tags WHERE transaction_id=?').bind(txId).run();
  await env.DB.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').bind(txId).run();
  await env.DB.prepare('DELETE FROM notes WHERE transaction_id=?').bind(txId).run();
  await env.DB.prepare('DELETE FROM attachments WHERE transaction_id=?').bind(txId).run();
  await env.DB.prepare('DELETE FROM transactions WHERE id=?').bind(txId).run();
  await audit(env, 'transaction', txId, 'delete', before, null, { hard: true });
  return json({ ok: true });
}

async function restoreTransaction(env: Env, txId: string): Promise<Response> {
  const before = await env.DB.prepare(
    'SELECT * FROM transactions WHERE id=? AND deleted_at IS NOT NULL'
  )
    .bind(txId)
    .first<Row>();
  if (!before) throw new HttpError(404, 'No trashed transaction found');
  const at = now();
  await env.DB.prepare('UPDATE transactions SET deleted_at=NULL, updated_at=? WHERE id=?')
    .bind(at, txId)
    .run();
  await audit(env, 'transaction', txId, 'restore', before, { ...before, deleted_at: null });
  return json({ ok: true });
}

async function purgeAllTrash(env: Env): Promise<{ purged: number }> {
  const trashed = await env.DB.prepare(
    'SELECT id FROM transactions WHERE deleted_at IS NOT NULL'
  ).all<Row>();
  for (const t of trashed.results) await deleteTransaction(env, t.id, true);
  return { purged: trashed.results.length };
}

// ---------------- master data ----------------
async function listAll(
  env: Env,
  table: string,
  order: string,
  includeDeleted = false
): Promise<Row[]> {
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL ';
  return (await env.DB.prepare(`SELECT * FROM ${table} ${where}ORDER BY ${order}`).all<Row>())
    .results;
}

async function createAccount(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const name = str(b, 'name');
  if (!name) throw new HttpError(400, 'Account name is required');
  const at = now();
  const opening =
    b['openingBalance'] !== undefined ? Math.round(Number(b['openingBalance']) * 100) : 0;
  const currency = str(b, 'currency') || 'INR';
  const a = {
    id: id(),
    name,
    currency,
    opening_balance_minor: opening,
    opening_balance_at: toIso(b['openingBalanceAt'], at),
    is_active: 1,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO accounts (id,name,currency,opening_balance_minor,opening_balance_at,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)'
  )
    .bind(a.id, name, currency, opening, a.opening_balance_at, at, at)
    .run();
  await audit(env, 'account', a.id, 'create', null, a);
  return json(a, { status: 201 });
}

async function updateAccount(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'accounts', idVal);
  if (!before) throw new HttpError(404, 'Account not found');
  const b = await readJson(request);
  const at = now();
  const name = b['name'] !== undefined ? String(b['name']).trim() : before.name;
  if (!name) throw new HttpError(400, 'Account name is required');
  const currency =
    b['currency'] !== undefined ? String(b['currency']).trim() || 'INR' : before.currency;
  const opening =
    b['openingBalance'] !== undefined
      ? Math.round(Number(b['openingBalance']) * 100)
      : before.opening_balance_minor;
  const updated = { ...before, name, currency, opening_balance_minor: opening, updated_at: at };
  await env.DB.prepare(
    'UPDATE accounts SET name=?,currency=?,opening_balance_minor=?,updated_at=? WHERE id=?'
  )
    .bind(name, currency, opening, at, idVal)
    .run();
  await audit(env, 'account', idVal, 'update', before, updated);
  return json(updated);
}

async function createCategory(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const name = str(b, 'name');
  if (!name) throw new HttpError(400, 'Category name is required');
  const parentId = optStr(b, 'parentId');
  const kind = ['expense', 'income', 'both'].includes(String(b['kind']))
    ? String(b['kind'])
    : 'expense';
  if (parentId && !(await exists(env, 'categories', parentId)))
    throw new HttpError(400, 'Parent category not found');
  const at = now();
  const c = {
    id: id(),
    name,
    parent_id: parentId,
    kind,
    sort_order: 0,
    is_active: 1,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO categories (id,name,parent_id,kind,sort_order,is_active,created_at,updated_at) VALUES (?,?,?,?,0,1,?,?)'
  )
    .bind(c.id, name, parentId, kind, at, at)
    .run();
  await audit(env, 'category', c.id, 'create', null, c);
  return json(c, { status: 201 });
}

async function updateCategory(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'categories', idVal);
  if (!before) throw new HttpError(404, 'Category not found');
  const b = await readJson(request);
  const at = now();
  const name = b['name'] !== undefined ? String(b['name']).trim() : before.name;
  const parentId =
    b['parentId'] === null || b['parentId'] === ''
      ? null
      : b['parentId'] !== undefined
        ? String(b['parentId'])
        : before.parent_id;
  const kind =
    b['kind'] !== undefined
      ? ['expense', 'income', 'both'].includes(String(b['kind']))
        ? String(b['kind'])
        : before.kind
      : before.kind;
  if (!name) throw new HttpError(400, 'Category name is required');
  if (parentId === idVal) throw new HttpError(400, 'A category cannot be its own parent');
  if (parentId && !(await exists(env, 'categories', parentId)))
    throw new HttpError(400, 'Parent category not found');
  const updated = { ...before, name, parent_id: parentId, kind, updated_at: at };
  await env.DB.prepare('UPDATE categories SET name=?,parent_id=?,kind=?,updated_at=? WHERE id=?')
    .bind(name, parentId, kind, at, idVal)
    .run();
  await audit(env, 'category', idVal, 'update', before, updated);
  return json(updated);
}

async function createMethod(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const name = str(b, 'name');
  const accountId = str(b, 'accountId');
  if (!name || !accountId) throw new HttpError(400, 'Payment method name and account are required');
  if (!(await exists(env, 'accounts', accountId))) throw new HttpError(400, 'Account not found');
  const at = now();
  const m = {
    id: id(),
    account_id: accountId,
    name,
    is_active: 1,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO payment_methods (id,account_id,name,is_active,created_at,updated_at) VALUES (?,?,?,?,1,?)'
  )
    .bind(m.id, accountId, name, at, at)
    .run();
  await audit(env, 'payment_method', m.id, 'create', null, m);
  return json(m, { status: 201 });
}

async function updateMethod(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'payment_methods', idVal);
  if (!before) throw new HttpError(404, 'Payment method not found');
  const b = await readJson(request);
  const at = now();
  const name = b['name'] !== undefined ? String(b['name']).trim() : before.name;
  const accountId = b['accountId'] !== undefined ? String(b['accountId']) : before.account_id;
  if (!name || !accountId) throw new HttpError(400, 'Payment method name and account are required');
  if (!(await exists(env, 'accounts', accountId))) throw new HttpError(400, 'Account not found');
  const updated = { ...before, name, account_id: accountId, updated_at: at };
  await env.DB.prepare('UPDATE payment_methods SET name=?,account_id=?,updated_at=? WHERE id=?')
    .bind(name, accountId, at, idVal)
    .run();
  await audit(env, 'payment_method', idVal, 'update', before, updated);
  return json(updated);
}

async function createPayee(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const name = str(b, 'name');
  if (!name) throw new HttpError(400, 'Payee name is required');
  const address = str(b, 'address');
  const at = now();
  const p = {
    id: id(),
    name,
    address,
    is_active: 1,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO payees (id,name,address,is_active,created_at,updated_at) VALUES (?,?,?,1,?,?)'
  )
    .bind(p.id, name, address, at, at)
    .run();
  await audit(env, 'payee', p.id, 'create', null, p);
  return json(p, { status: 201 });
}

async function updatePayee(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'payees', idVal);
  if (!before) throw new HttpError(404, 'Payee not found');
  const b = await readJson(request);
  const at = now();
  const name = b['name'] !== undefined ? String(b['name']).trim() : before.name;
  const address = b['address'] !== undefined ? String(b['address']) : before.address || '';
  if (!name) throw new HttpError(400, 'Payee name is required');
  const updated = { ...before, name, address, updated_at: at };
  await env.DB.prepare('UPDATE payees SET name=?,address=?,updated_at=? WHERE id=?')
    .bind(name, address, at, idVal)
    .run();
  await audit(env, 'payee', idVal, 'update', before, updated);
  return json(updated);
}

async function createTag(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const name = str(b, 'name');
  if (!name) throw new HttpError(400, 'Tag name is required');
  const at = now();
  const t = { id: id(), name, created_at: at, updated_at: at, deleted_at: null };
  await env.DB.prepare('INSERT INTO tags (id,name,created_at,updated_at) VALUES (?,?,?,?)')
    .bind(t.id, name, at, at)
    .run();
  await audit(env, 'tag', t.id, 'create', null, t);
  return json(t, { status: 201 });
}

async function updateTag(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'tags', idVal);
  if (!before) throw new HttpError(404, 'Tag not found');
  const b = await readJson(request);
  const at = now();
  const name = b['name'] !== undefined ? String(b['name']).trim() : before.name;
  if (!name) throw new HttpError(400, 'Tag name is required');
  const updated = { ...before, name, updated_at: at };
  await env.DB.prepare('UPDATE tags SET name=?,updated_at=? WHERE id=?')
    .bind(name, at, idVal)
    .run();
  await audit(env, 'tag', idVal, 'update', before, updated);
  return json(updated);
}

async function softDelete(
  env: Env,
  table: string,
  entityType: string,
  idVal: string
): Promise<Response> {
  const before = await getEntity(env, table, idVal);
  if (!before) throw new HttpError(404, 'Not found');
  const at = now();
  await env.DB.prepare(`UPDATE ${table} SET deleted_at=?, updated_at=? WHERE id=?`)
    .bind(at, at, idVal)
    .run();
  await audit(env, entityType, idVal, 'delete', before, { ...before, deleted_at: at });
  return json({ ok: true });
}

// ---------------- attachments ----------------
function mapAttachment(r: Row) {
  return { ...r, kind: r.provider, url: r.external_file_id };
}

async function listAttachments(env: Env, url: URL): Promise<Response> {
  const transactionId = url.searchParams.get('transactionId');
  const clauses = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (transactionId) {
    clauses.push('transaction_id=?');
    params.push(transactionId);
  }
  const r = await env.DB.prepare(
    `SELECT * FROM attachments WHERE ${clauses.join(' AND ')} ORDER BY created_at LIMIT 200`
  )
    .bind(...params)
    .all<Row>();
  return json(r.results.map(mapAttachment));
}

async function createAttachment(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request, 3_000_000);
  const at = now();
  const transactionId = str(b, 'transactionId');
  if (!transactionId || !(await exists(env, 'transactions', transactionId)))
    throw new HttpError(400, 'Valid transactionId is required');
  const kind = b['kind'] === 'image' ? 'image' : 'file';
  const url = str(b, 'url');
  if (!url) throw new HttpError(400, 'url is required');
  const fileName = str(b, 'fileName');
  const mimeType =
    str(b, 'mimeType') || (kind === 'image' ? 'image/jpeg' : 'application/octet-stream');
  const sizeBytes =
    b['sizeBytes'] !== undefined && b['sizeBytes'] !== null ? asIntSafe(b['sizeBytes']) : null;
  const a = {
    id: id(),
    transaction_id: transactionId,
    provider: kind,
    external_file_id: url,
    file_name: fileName,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO attachments (id,transaction_id,provider,external_file_id,file_name,mime_type,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  )
    .bind(
      a.id,
      a.transaction_id,
      a.provider,
      a.external_file_id,
      fileName,
      mimeType,
      sizeBytes,
      at,
      at
    )
    .run();
  await audit(env, 'attachment', a.id, 'create', null, a);
  return json(mapAttachment(a), { status: 201 });
}

function asIntSafe(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// ---------------- recurring ----------------
async function listRecurring(env: Env): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT * FROM recurring_rules WHERE deleted_at IS NULL ORDER BY is_active DESC, next_due_at`
  ).all<Row>();
  return json(r.results);
}

async function ruleFromBody(
  env: Env,
  b: Record<string, unknown>,
  at: string,
  defaults: Row
): Promise<Record<string, unknown>> {
  const name = str(b, 'name');
  const type = b['type'] !== undefined ? String(b['type']) : defaults.transaction_type;
  const accountId = b['accountId'] !== undefined ? String(b['accountId']) : defaults.account_id;
  const amount = b['amount'] !== undefined ? toMinorStrict(b['amount']) : defaults.amount_minor;
  const frequency = b['frequency'] !== undefined ? String(b['frequency']) : defaults.frequency;
  const interval =
    b['interval'] !== undefined
      ? clampInt(b['interval'], 1, 365, defaults.interval_value || 1)
      : defaults.interval_value || 1;
  if (!name) throw new HttpError(400, 'name is required');
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'type must be expense or income');
  if (!(amount > 0)) throw new HttpError(400, 'amount must be greater than zero');
  if (!FREQ_RE.test(frequency)) throw new HttpError(400, 'invalid frequency');
  if (!(await exists(env, 'accounts', accountId))) throw new HttpError(400, 'Account not found');
  const categoryId =
    b['categoryId'] === null
      ? null
      : b['categoryId'] !== undefined
        ? String(b['categoryId'])
        : defaults.category_id;
  const methodId =
    b['methodId'] === null
      ? null
      : b['methodId'] !== undefined
        ? String(b['methodId'])
        : defaults.payment_method_id;
  if (categoryId && !(await exists(env, 'categories', categoryId)))
    throw new HttpError(400, 'Category not found');
  if (methodId && !(await exists(env, 'payment_methods', methodId)))
    throw new HttpError(400, 'Payment method not found');
  let payeeId =
    b['payeeId'] === null
      ? null
      : b['payeeId'] !== undefined
        ? String(b['payeeId'])
        : defaults.payee_id;
  if (b['payee'] !== undefined) payeeId = await upsertPayee(env, str(b, 'payee'), at);
  const noOfPayments =
    b['noOfPayments'] === null || b['noOfPayments'] === undefined
      ? (defaults.no_of_payments ?? null)
      : clampInt(b['noOfPayments'], 1, 100000, 1);
  const nextDueAt =
    b['nextDueAt'] !== undefined ? toIso(b['nextDueAt']) : defaults.next_due_at || at;
  return {
    name,
    transaction_type: type,
    account_id: accountId,
    payment_method_id: methodId,
    category_id: categoryId,
    payee_id: payeeId,
    amount_minor: amount,
    description:
      b['description'] !== undefined ? String(b['description']) : defaults.description || '',
    note: b['note'] !== undefined ? String(b['note']) : defaults.note || '',
    frequency,
    interval_value: interval,
    no_of_payments: noOfPayments,
    next_due_at: nextDueAt,
  };
}

async function createRecurring(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const at = now();
  const f = await ruleFromBody(env, b, at, {} as Row);
  const idVal = id();
  await env.DB.prepare(
    `INSERT INTO recurring_rules (id,name,transaction_type,account_id,payment_method_id,category_id,payee_id,amount_minor,description,note,frequency,interval_value,no_of_payments,next_due_at,is_active,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
  )
    .bind(
      idVal,
      f.name,
      f.transaction_type,
      f.account_id,
      f.payment_method_id,
      f.category_id,
      f.payee_id,
      f.amount_minor,
      f.description,
      f.note,
      f.frequency,
      f.interval_value,
      f.no_of_payments,
      f.next_due_at,
      at,
      at
    )
    .run();
  const created = await env.DB.prepare('SELECT * FROM recurring_rules WHERE id=?')
    .bind(idVal)
    .first<Row>();
  await audit(env, 'recurring_rule', idVal, 'create', null, created);
  return json(created, { status: 201 });
}

async function updateRecurring(env: Env, request: Request, idVal: string): Promise<Response> {
  const before = await getEntity(env, 'recurring_rules', idVal);
  if (!before) throw new HttpError(404, 'Recurring rule not found');
  const b = await readJson(request);
  const at = now();
  const f = await ruleFromBody(env, b, at, before);
  const updated = { ...before, ...f, updated_at: at };
  await env.DB.prepare(
    `UPDATE recurring_rules SET name=?,transaction_type=?,account_id=?,payment_method_id=?,category_id=?,payee_id=?,
     amount_minor=?,description=?,note=?,frequency=?,interval_value=?,no_of_payments=?,next_due_at=?,updated_at=? WHERE id=?`
  )
    .bind(
      f.name,
      f.transaction_type,
      f.account_id,
      f.payment_method_id,
      f.category_id,
      f.payee_id,
      f.amount_minor,
      f.description,
      f.note,
      f.frequency,
      f.interval_value,
      f.no_of_payments,
      f.next_due_at,
      at,
      idVal
    )
    .run();
  await audit(env, 'recurring_rule', idVal, 'update', before, updated);
  return json(updated);
}

async function generateOne(env: Env, idVal: string): Promise<Response> {
  const rule = await env.DB.prepare(
    'SELECT * FROM recurring_rules WHERE id=? AND deleted_at IS NULL'
  )
    .bind(idVal)
    .first<Row>();
  if (!rule) throw new HttpError(404, 'Recurring rule not found');
  const at = now();
  const count =
    (
      await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM transactions WHERE recurring_rule_id=? AND deleted_at IS NULL'
      )
        .bind(idVal)
        .first<Row>()
    )?.n ?? 0;
  if (rule.no_of_payments && count + 1 > rule.no_of_payments)
    throw new HttpError(400, 'Recurring rule has reached its payment limit');
  const txId = id();
  await env.DB.prepare(INSERT_TX)
    .bind(
      txId,
      rule.account_id,
      rule.payment_method_id,
      rule.category_id,
      rule.payee_id,
      rule.transaction_type,
      rule.amount_minor,
      rule.next_due_at,
      rule.description || rule.name,
      rule.note || '',
      'cleared',
      '',
      0,
      null,
      '',
      null,
      null,
      rule.id,
      0,
      at,
      at
    )
    .run();
  const next = advanceDue(rule.next_due_at, rule.frequency, rule.interval_value);
  await env.DB.prepare(
    'UPDATE recurring_rules SET next_due_at=?, last_generated_at=?, updated_at=? WHERE id=?'
  )
    .bind(next, rule.next_due_at, at, idVal)
    .run();
  await audit(
    env,
    'transaction',
    txId,
    'create',
    null,
    { recurring_rule_id: idVal, occurred_at: rule.next_due_at },
    { recurring: true }
  );
  const updated = await env.DB.prepare('SELECT * FROM recurring_rules WHERE id=?')
    .bind(idVal)
    .first<Row>();
  return json({ ok: true, txId, nextDue: next, rule: updated });
}

async function skipRecurring(env: Env, idVal: string): Promise<Response> {
  const rule = await env.DB.prepare(
    'SELECT * FROM recurring_rules WHERE id=? AND deleted_at IS NULL'
  )
    .bind(idVal)
    .first<Row>();
  if (!rule) throw new HttpError(404, 'Recurring rule not found');
  const at = now();
  const next = advanceDue(rule.next_due_at, rule.frequency, rule.interval_value);
  await env.DB.prepare('UPDATE recurring_rules SET next_due_at=?, updated_at=? WHERE id=?')
    .bind(next, at, idVal)
    .run();
  await audit(
    env,
    'recurring_rule',
    idVal,
    'update',
    rule,
    { ...rule, next_due_at: next },
    { skipped: true }
  );
  return json({ ok: true, nextDue: next });
}

async function toggleRecurring(env: Env, idVal: string): Promise<Response> {
  const rule = await getEntity(env, 'recurring_rules', idVal);
  if (!rule) throw new HttpError(404, 'Recurring rule not found');
  const at = now();
  const active = rule.is_active ? 0 : 1;
  await env.DB.prepare('UPDATE recurring_rules SET is_active=?, updated_at=? WHERE id=?')
    .bind(active, at, idVal)
    .run();
  await audit(env, 'recurring_rule', idVal, 'update', rule, { ...rule, is_active: active });
  return json({ ok: true, is_active: active });
}

// ---------------- import / export / backup / drive ----------------
async function handleImportCsv(env: Env, request: Request, url: URL): Promise<Response> {
  const raw = await readBody(request, 10_000_000);
  let mode: 'append' | 'replace' =
    url.searchParams.get('mode') === 'replace' ? 'replace' : 'append';
  let csvText = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.csv !== 'string') throw new HttpError(400, 'Expected a "csv" string field');
    csvText = parsed.csv;
    if (parsed.mode === 'append' || parsed.mode === 'replace') mode = parsed.mode;
  }
  const summary = await importCsv(env, csvText, mode);
  return json(summary, { status: 200 });
}

async function handleRestoreBackup(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request, 20_000_000);
  const result = await restoreBackup(env, b);
  return json(result);
}

async function handleExportCsv(env: Env, url: URL): Promise<Response> {
  const csv = await exportCsv(env, {
    type: url.searchParams.get('type') || undefined,
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
  });
  return textBody(csv, 'text/csv; charset=utf-8', {
    headers: { 'content-disposition': 'attachment; filename="expenses.csv"' },
  });
}

async function handleDriveBackup(env: Env): Promise<Response> {
  const backup = await exportJson(env);
  const res = await driveBackup(env, backup);
  return json(res);
}

async function handleDriveRestore(env: Env): Promise<Response> {
  const backup = await driveRestore(env);
  const res = await restoreBackup(env, backup);
  return json(res);
}

// ---------------- bootstrap / search / audit ----------------
async function handleBootstrap(env: Env): Promise<Response> {
  const [accounts, categories, methods, payees, tags, suggestions, recurring] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`
    ).all<Row>(),
    env.DB.prepare(
      `SELECT * FROM categories WHERE deleted_at IS NULL AND is_active=1 ORDER BY parent_id IS NOT NULL, sort_order, name`
    ).all<Row>(),
    env.DB.prepare(
      `SELECT * FROM payment_methods WHERE deleted_at IS NULL AND is_active=1 ORDER BY account_id, name`
    ).all<Row>(),
    env.DB.prepare(
      `SELECT * FROM payees WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`
    ).all<Row>(),
    env.DB.prepare(`SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY name`).all<Row>(),
    env.DB.prepare(
      `SELECT description FROM description_suggestions ORDER BY usage_count DESC, last_used_at DESC LIMIT 100`
    ).all<Row>(),
    env.DB.prepare(
      `SELECT * FROM recurring_rules WHERE deleted_at IS NULL AND is_active=1 ORDER BY next_due_at`
    ).all<Row>(),
  ]);
  return json({
    accounts: accounts.results,
    categories: categories.results,
    paymentMethods: methods.results,
    payees: payees.results,
    tags: tags.results,
    suggestions: suggestions.results.map((x) => x.description),
    recurring: recurring.results,
  });
}

async function handleSearchOptions(env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q)
    return json({
      descriptions: [],
      categories: [],
      methods: [],
      accounts: [],
      payees: [],
      tags: [],
    });
  const s = `%${q}%`;
  const [descriptions, categories, methods, accounts, payees, tags] = await Promise.all([
    env.DB.prepare(
      'SELECT description AS value, usage_count AS count FROM description_suggestions WHERE description LIKE ? ORDER BY usage_count DESC, last_used_at DESC LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
    env.DB.prepare(
      'SELECT id, name, kind, parent_id FROM categories WHERE deleted_at IS NULL AND is_active=1 AND name LIKE ? ORDER BY name LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
    env.DB.prepare(
      'SELECT id, name, account_id FROM payment_methods WHERE deleted_at IS NULL AND is_active=1 AND name LIKE ? ORDER BY name LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
    env.DB.prepare(
      'SELECT id, name FROM accounts WHERE deleted_at IS NULL AND is_active=1 AND name LIKE ? ORDER BY name LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
    env.DB.prepare(
      'SELECT id, name FROM payees WHERE deleted_at IS NULL AND is_active=1 AND name LIKE ? ORDER BY name LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
    env.DB.prepare(
      'SELECT id, name FROM tags WHERE deleted_at IS NULL AND name LIKE ? ORDER BY name LIMIT 8'
    )
      .bind(s)
      .all<Row>(),
  ]);
  return json({
    descriptions: descriptions.results,
    categories: categories.results,
    methods: methods.results,
    accounts: accounts.results,
    payees: payees.results,
    tags: tags.results,
  });
}

async function handleAudit(env: Env, url: URL): Promise<Response> {
  const entityType = url.searchParams.get('entityType');
  const entityId = url.searchParams.get('entityId');
  const clauses = [];
  const params: unknown[] = [];
  if (entityType) {
    clauses.push('entity_type=?');
    params.push(entityType);
  }
  if (entityId) {
    clauses.push('entity_id=?');
    params.push(entityId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const r = await env.DB.prepare(
    `SELECT * FROM audit_log${where} ORDER BY occurred_at DESC LIMIT 300`
  )
    .bind(...params)
    .all<Row>();
  return json(r.results);
}

// ---------------- dispatcher ----------------
export async function route(request: Request, url: URL, env: Env): Promise<Response> {
  const p = url.pathname;
  const m = request.method;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','transactions','<id>']
  const res = (r: Response) => {
    const headers = new Headers(r.headers);
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
    return new Response(r.body, { status: r.status, headers });
  };

  if (m === 'GET' && p === '/api/health') {
    const r = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return res(json({ ok: r?.ok === 1 }));
  }
  if (m === 'GET' && p === '/api/bootstrap') return res(await handleBootstrap(env));
  if (m === 'GET' && p === '/api/search-options') return res(await handleSearchOptions(env, url));
  if (m === 'GET' && p === '/api/dashboard') return res(json(await buildDashboard(env)));
  if (m === 'GET' && p === '/api/dashboard/frame') {
    const from = url.searchParams.get('from');
    if (!from) throw new HttpError(400, '"from" is required');
    const to = url.searchParams.get('to');
    return res(json(await rangeStats(env, toIso(from), to ? toIso(to) : null)));
  }
  if (m === 'GET' && p === '/api/dashboard/categories') {
    const from = url.searchParams.get('from');
    if (!from) throw new HttpError(400, '"from" is required');
    const to = url.searchParams.get('to');
    return res(json(await categoryBreakdown(env, toIso(from), to ? toIso(to) : null)));
  }
  if (m === 'GET' && p === '/api/audit') return res(await handleAudit(env, url));

  if (p === '/api/transactions') {
    if (m === 'GET') return res(await listTransactions(env, url));
    if (m === 'POST') return res(await createTransaction(env, request));
  }
  if (seg[1] === 'transactions' && seg[2]) {
    const txId = seg[2];
    if (m === 'GET' && seg[3] === 'audit')
      return res(
        await handleAudit(
          env,
          new URL(
            `http://x/api/audit?entityType=transaction&entityId=${encodeURIComponent(txId)}`,
            url.origin
          )
        )
      );
    if (m === 'GET' && !seg[3]) {
      const t = await txDetail(env, txId);
      return res(t ? json(t) : json({ error: 'Transaction not found' }, { status: 404 }));
    }
    if (m === 'PUT' && !seg[3]) return res(await updateTransaction(env, request, txId));
    if (m === 'DELETE' && !seg[3])
      return res(await deleteTransaction(env, txId, url.searchParams.get('hard') === '1'));
    if (m === 'POST' && seg[3] === 'restore') return res(await restoreTransaction(env, txId));
    if (m === 'POST' && seg[3] === 'purge') return res(await deleteTransaction(env, txId, true));
  }
  if (p === '/api/trash') {
    if (m === 'GET')
      return res(
        await listTransactions(
          env,
          new URL(`http://x/api/transactions?deleted=1&limit=500`, url.origin)
        )
      );
    if (m === 'POST' && seg[2] === 'purge') return res(json(await purgeAllTrash(env)));
  }

  // master data
  const master: Record<string, { table: string; entity: string; order: string }> = {
    accounts: { table: 'accounts', entity: 'account', order: 'name' },
    categories: {
      table: 'categories',
      entity: 'category',
      order: 'parent_id IS NOT NULL, sort_order, name',
    },
    'payment-methods': {
      table: 'payment_methods',
      entity: 'payment_method',
      order: 'account_id, name',
    },
    payees: { table: 'payees', entity: 'payee', order: 'name' },
    tags: { table: 'tags', entity: 'tag', order: 'name' },
  };
  if (seg[1] && master[seg[1]]) {
    const spec = master[seg[1]];
    if (m === 'GET' && !seg[2]) return res(json(await listAll(env, spec.table, spec.order)));
    if (m === 'POST' && !seg[2]) {
      if (seg[1] === 'accounts') return res(await createAccount(env, request));
      if (seg[1] === 'categories') return res(await createCategory(env, request));
      if (seg[1] === 'payment-methods') return res(await createMethod(env, request));
      if (seg[1] === 'payees') return res(await createPayee(env, request));
      if (seg[1] === 'tags') return res(await createTag(env, request));
    }
    if (m === 'PUT' && seg[2]) {
      if (seg[1] === 'accounts') return res(await updateAccount(env, request, seg[2]));
      if (seg[1] === 'categories') return res(await updateCategory(env, request, seg[2]));
      if (seg[1] === 'payment-methods') return res(await updateMethod(env, request, seg[2]));
      if (seg[1] === 'payees') return res(await updatePayee(env, request, seg[2]));
      if (seg[1] === 'tags') return res(await updateTag(env, request, seg[2]));
    }
    if (m === 'DELETE' && seg[2])
      return res(await softDelete(env, spec.table, spec.entity, seg[2]));
  }

  // attachments
  if (seg[1] === 'attachments') {
    if (m === 'GET' && !seg[2]) return res(await listAttachments(env, url));
    if (m === 'POST' && !seg[2]) return res(await createAttachment(env, request));
    if (m === 'DELETE' && seg[2])
      return res(await softDelete(env, 'attachments', 'attachment', seg[2]));
  }

  // recurring
  if (seg[1] === 'recurring') {
    if (m === 'GET' && !seg[2]) return res(await listRecurring(env));
    if (m === 'POST' && !seg[2]) return res(await createRecurring(env, request));
    if (seg[2]) {
      if (m === 'PUT' && !seg[3]) return res(await updateRecurring(env, request, seg[2]));
      if (m === 'DELETE' && !seg[3])
        return res(await softDelete(env, 'recurring_rules', 'recurring_rule', seg[2]));
      if (m === 'POST' && seg[3] === 'generate') return res(await generateOne(env, seg[2]));
      if (m === 'POST' && seg[3] === 'skip') return res(await skipRecurring(env, seg[2]));
      if (m === 'PATCH' && seg[3] === 'toggle') return res(await toggleRecurring(env, seg[2]));
    }
  }

  // import / export / backup / drive
  if (m === 'POST' && p === '/api/import/csv') return res(await handleImportCsv(env, request, url));
  if (m === 'POST' && (p === '/api/import/backup' || p === '/api/backup/restore'))
    return res(await handleRestoreBackup(env, request));
  if (m === 'GET' && p === '/api/export/csv') return res(await handleExportCsv(env, url));
  if (m === 'GET' && (p === '/api/export/json' || p === '/api/backup'))
    return res(json(await exportJson(env)));
  if (m === 'POST' && p === '/api/drive/backup') return res(await handleDriveBackup(env));
  if (m === 'POST' && p === '/api/drive/restore') return res(await handleDriveRestore(env));
  if (m === 'GET' && p === '/api/drive/status') return res(json(await driveStatus(env)));
  if (m === 'GET' && p === '/api/drive/connect') {
    const location = driveAuthUrl(env, url);
    return res(new Response(null, { status: 302, headers: { location } }));
  }
  if (m === 'GET' && p === '/api/drive/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const back = `${url.protocol}//${url.host}/?manage=data`;
    if (error)
      return res(new Response(null, { status: 302, headers: { location: `${back}&drive=error` } }));
    if (!code) throw new HttpError(400, 'Missing authorization code.');
    await driveHandleCallback(env, url, code);
    return res(
      new Response(null, { status: 302, headers: { location: `${back}&drive=connected` } })
    );
  }
  if (m === 'POST' && p === '/api/drive/disconnect') {
    await driveDisconnect(env);
    return res(json({ ok: true }));
  }
  if (m === 'POST' && p === '/api/drive/auto-backup') {
    const b = await readJson(request);
    await driveSetAutoBackup(env, Boolean(b['enabled']));
    return res(json({ ok: true }));
  }
  if (m === 'POST' && p === '/api/recurring/run') return res(json(await runRecurring(env)));

  return res(json({ error: 'Not found' }, { status: 404 }));
}
