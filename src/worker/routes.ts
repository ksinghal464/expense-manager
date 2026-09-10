import { Env, HttpError, json, textBody, readJson, readBody } from './http';
import {
  now,
  id,
  audit,
  exists,
  getEntity,
  toIso,
  toMinorStrict,
  clampInt,
  INSERT_TX,
  INSERT_TX_RECURRING_IDEMPOTENT,
  checkTxReferences,
  touchDescriptionSuggestion,
  validateTxReferences,
} from './db';
import { buildDashboard, rangeStats, categoryBreakdown, entityBreakdown } from './aggregate';
import { runRecurring, advanceDue } from './recurring';
import { importCsv, exportCsv, exportJson, restoreBackup } from './io';
import {
  driveAuthUrl,
  driveBackup,
  driveCallbackHtml,
  driveDisconnect,
  driveHandleCallback,
  driveRestore,
  driveSetAutoBackup,
  driveStatus,
  setDriveBackupError,
} from './drive';

type Row = Record<string, any>;

const TYPE_RE = /^(expense|income)$/;
const STATUS_RE = /^(cleared|uncleared)$/;
const FREQ_RE = /^(daily|weekly|monthly|yearly)$/;

const TX_SELECT = `SELECT t.*, a.name AS account_name, c.name AS category_name, p.name AS payee_name,
  pm.name AS payment_method_name, parent.description AS refund_of_description,
  parent.occurred_at AS refund_of_occurred_at, parent.amount_minor AS refund_of_amount_minor,
  (SELECT COALESCE(SUM(r.amount_minor),0) FROM transactions r
    WHERE r.refunds_transaction_id=t.id AND r.deleted_at IS NULL) AS refunded_minor,
  (SELECT COALESCE(SUM(r2.amount_minor),0) FROM transactions r2
    WHERE r2.refunds_transaction_id=t.refunds_transaction_id AND r2.deleted_at IS NULL) AS refund_siblings_total
  FROM transactions t
  LEFT JOIN accounts a ON a.id=t.account_id
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
  // Chunk to stay well under D1's per-statement bound-variable limit.
  const CHUNK = 100;
  for (let i = 0; i < txIds.length; i += CHUNK) {
    const slice = txIds.slice(i, i + CHUNK);
    const ph = slice.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT tt.transaction_id AS tid, tg.name FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id
       WHERE tt.transaction_id IN (${ph})`
    )
      .bind(...slice)
      .all<Row>();
    for (const x of r.results) (map[x.tid] ||= []).push(x.name);
  }
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
        OR LOWER(COALESCE(p.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(a.name,'')) LIKE LOWER(?)
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
    if (from && from > to) throw new HttpError(400, '"from" must not be after "to"');
    // [from, to) — consistent with the dashboard/Activity date-range convention.
    clauses.push('t.occurred_at < ?');
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
  await validateTxReferences(env, { accountId, methodId, categoryId, type });

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
  const occurredAt = str(b, 'occurredAt') || at;
  const split = Array.isArray(b['splits']) ? (b['splits'] as unknown[]) : [];
  if (split.length) {
    let total = 0;
    for (const item of split) {
      if (!item || typeof item !== 'object') throw new HttpError(400, 'Invalid split entry');
      const s = item as Record<string, unknown>;
      const splitAmount = toMinorStrict(s['amount']);
      const splitCategoryId = optStr(s, 'categoryId');
      if (!(splitAmount > 0) || !splitCategoryId)
        throw new HttpError(400, 'Each split requires amount and categoryId');
      total += splitAmount;
    }
    if (total !== amountMinor) throw new HttpError(400, 'Split amounts must equal transaction amount');
  }

  const txId = id();
  await env.DB.prepare(INSERT_TX)
    .bind(
      txId,
      accountId,
      categoryId,
      methodId,
      payeeId,
      type,
      amountMinor,
      description,
      note,
      occurredAt,
      status,
      refundsTransactionId,
      at,
      at
    )
    .run();

  if (split.length) {
    for (const item of split) {
      const s = item as Record<string, unknown>;
      const splitId = id();
      await env.DB.prepare(
        'INSERT INTO transaction_splits (id,transaction_id,category_id,amount_minor,description,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
      )
        .bind(
          splitId,
          txId,
          optStr(s, 'categoryId'),
          toMinorStrict(s['amount']),
          str(s, 'description'),
          str(s, 'note'),
          at,
          at
        )
        .run();
    }
  }

  const tags = Array.isArray(b['tags']) ? (b['tags'] as unknown[]) : [];
  for (const tag of tags) {
    const tagId = await upsertTag(env, String(tag), at);
    if (tagId)
      await env.DB.prepare('INSERT OR IGNORE INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)')
        .bind(txId, tagId)
        .run();
  }

  await touchDescriptionSuggestion(env, description, at);
  const created = await txDetail(env, txId);
  await audit(env, 'transaction', txId, 'create', null, created);
  return json(created, { status: 201 });
}

async function upsertPayeePlaceholder(env: Env): Promise<void> {
  return;
}

// ...
