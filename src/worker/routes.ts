import { Env, HttpError, json, textBody, readJson, readBody } from './http';
import {
  now,
  id,
  audit,
  auditStmt,
  batchAll,
  touchSuggestionStmts,
  untouchSuggestionStmts,
  exists,
  getEntity,
  toIso,
  toMinorStrict,
  clampInt,
  runBatches,
  INSERT_TX,
  INSERT_TX_RECURRING_IDEMPOTENT,
  checkTxReferences,
  touchDescriptionSuggestion,
  untouchDescriptionSuggestion,
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
  cp.account_id AS transfer_counterpart_account_id, cpacc.name AS transfer_counterpart_account_name,
  cp.payment_method_id AS transfer_counterpart_method_id,
  cppm.name AS transfer_counterpart_method_name,
  xfer.description AS transfer_description,
  (SELECT COALESCE(SUM(r.amount_minor),0) FROM transactions r
    WHERE r.refunds_transaction_id=t.id AND r.deleted_at IS NULL) AS refunded_minor,
  (SELECT COALESCE(SUM(r2.amount_minor),0) FROM transactions r2
    WHERE r2.refunds_transaction_id=t.refunds_transaction_id AND r2.deleted_at IS NULL) AS refund_siblings_total
  FROM transactions t
  LEFT JOIN accounts a ON a.id=t.account_id
  LEFT JOIN categories c ON c.id=t.category_id
  LEFT JOIN payees p ON p.id=t.payee_id
  LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id
  LEFT JOIN transactions parent ON parent.id=t.refunds_transaction_id
  LEFT JOIN transactions cp ON cp.transfer_id=t.transfer_id AND cp.id<>t.id AND cp.deleted_at IS NULL
  LEFT JOIN accounts cpacc ON cpacc.id=cp.account_id
  LEFT JOIN payment_methods cppm ON cppm.id=cp.payment_method_id
  LEFT JOIN transfers xfer ON xfer.id=t.transfer_id`;

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

async function listTransactions(env: Env, url: URL, trashOnly = false): Promise<Response> {
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

  const clauses = [
    trashOnly ? 't.deleted_at IS NOT NULL' : includeDeleted ? '1=1' : 't.deleted_at IS NULL',
  ];
  const params: unknown[] = [];
  const before = url.searchParams.get('before');
  const beforeCreated = url.searchParams.get('beforeCreated');
  const beforeId = url.searchParams.get('beforeId');
  if (before || beforeCreated || beforeId) {
    if (!before || !beforeCreated || !beforeId) throw new HttpError(400, 'Incomplete cursor');
    clauses.push('(t.occurred_at, t.created_at, t.id) < (?, ?, ?)');
    params.push(before, beforeCreated, beforeId);
  }
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
    `${TX_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<Row>();
  const tags = await tagsForMany(
    env,
    r.results.map((x) => x.id)
  );
  return json(r.results.map((t) => ({ ...t, tags: tags[t.id] || [] })));
}

// ---------------- transaction writes ----------------
// Each save is two D1 round trips: one batch of reads (everything needed to
// validate), then one batch that does every write, the audit entry and reads
// back the changed rows. A batch runs as a single transaction, so a failed save
// leaves nothing half-written.

const SPLIT_INSERT =
  'INSERT INTO transaction_splits (id,transaction_id,category_id,amount_minor,description,note,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)';
const SPLITS_OF = `SELECT s.*, c.name AS category_name FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id
  WHERE s.transaction_id=? AND s.deleted_at IS NULL ORDER BY s.created_at`;
const REFUNDS_OF = `SELECT r.id, r.occurred_at, r.amount_minor, r.description, r.account_id, a.name AS account_name
  FROM transactions r JOIN accounts a ON a.id=r.account_id
  WHERE r.refunds_transaction_id=? AND r.deleted_at IS NULL ORDER BY r.occurred_at`;

/**
 * Two statements that read back, in list (TxView) shape with tags, every live
 * transaction the client must replace after a write touching `ids`: the rows
 * themselves, their refunds, refunds sharing them as parent (whose "refunded so
 * far" totals change), and the other leg of any transfer.
 */
function changedRowsStmts(env: Env, ids: (string | null | undefined)[]): D1PreparedStatement[] {
  const list = JSON.stringify([...new Set(ids.filter(Boolean))]);
  const where = `t.deleted_at IS NULL AND (t.id IN (SELECT value FROM json_each(?))
    OR t.refunds_transaction_id IN (SELECT value FROM json_each(?))
    OR t.transfer_id IN (SELECT transfer_id FROM transactions
      WHERE id IN (SELECT value FROM json_each(?)) AND transfer_id IS NOT NULL))`;
  return [
    env.DB.prepare(
      `${TX_SELECT} WHERE ${where} ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC`
    ).bind(list, list, list),
    env.DB.prepare(
      `SELECT tt.transaction_id AS tid, tg.name FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id
       WHERE tt.transaction_id IN (SELECT t.id FROM transactions t WHERE ${where})`
    ).bind(list, list, list),
  ];
}

function changedRows(rows: D1Result<Row>, tags: D1Result<Row>): Row[] {
  const map: Record<string, string[]> = {};
  for (const x of tags.results) (map[x.tid] ||= []).push(x.name);
  return rows.results.map((t) => ({ ...t, tags: map[t.id] || [] }));
}

type TxLookup = {
  before: Row | null;
  refs: Row;
  refundTarget: Row | null;
  payeeId: string | null;
  tagIds: Map<string, string>;
  splitCategories: Map<string, string>;
  oldSplits: Row[];
};

/**
 * One read batch for a transaction save. For an edit (`txId` set), any ref
 * left `undefined` falls back to the stored row's value inside the SQL, so the
 * stored row doesn't have to be fetched first.
 */
async function lookupTx(
  env: Env,
  q: {
    txId: string | null;
    accountId?: string;
    methodId?: string;
    categoryId?: string;
    refundsTransactionId?: string | null;
    payeeName?: string | null;
    tagNames: string[];
    splitCategoryIds: string[];
    withOldSplits: boolean;
  }
): Promise<TxLookup> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('SELECT * FROM transactions WHERE id=? AND deleted_at IS NULL').bind(q.txId),
    env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM accounts WHERE id=r.acc AND deleted_at IS NULL) AS account_ok,
         EXISTS(SELECT 1 FROM categories WHERE id=r.cat AND deleted_at IS NULL) AS category_ok,
         (SELECT kind FROM categories WHERE id=r.cat AND deleted_at IS NULL) AS category_kind,
         EXISTS(SELECT 1 FROM payment_methods WHERE id=r.pm AND deleted_at IS NULL) AS method_ok,
         (SELECT account_id FROM payment_methods WHERE id=r.pm AND deleted_at IS NULL) AS method_account
       FROM (SELECT COALESCE(?, b.account_id) AS acc, COALESCE(?, b.payment_method_id) AS pm,
                    COALESCE(?, b.category_id) AS cat
             FROM (SELECT 1) one LEFT JOIN transactions b ON b.id=? AND b.deleted_at IS NULL) r`
    ).bind(q.accountId ?? null, q.methodId ?? null, q.categoryId ?? null, q.txId),
    // Refund target: the given id, or (when not given) the stored row's link.
    env.DB.prepare(
      `SELECT transaction_type, transfer_id FROM transactions WHERE deleted_at IS NULL
       AND id=COALESCE(?, (SELECT refunds_transaction_id FROM transactions WHERE id=?))`
    ).bind(q.refundsTransactionId ?? null, q.txId),
    env.DB.prepare('SELECT id FROM payees WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1').bind(
      (q.payeeName || '').toLowerCase()
    ),
    env.DB.prepare(
      `SELECT id, lower(name) AS k FROM tags WHERE deleted_at IS NULL
       AND lower(name) IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(q.tagNames.map((n) => n.toLowerCase()))),
    env.DB.prepare(
      `SELECT id, name FROM categories WHERE deleted_at IS NULL
       AND id IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(q.splitCategoryIds)),
  ];
  if (q.withOldSplits) stmts.push(env.DB.prepare(SPLITS_OF).bind(q.txId));
  const [before, refs, refund, payee, tags, cats, oldSplits] = await batchAll(env, stmts);
  const tagIds = new Map<string, string>();
  for (const t of tags.results) if (!tagIds.has(t.k)) tagIds.set(t.k, t.id);
  return {
    before: before.results[0] ?? null,
    refs: refs.results[0],
    refundTarget: refund.results[0] ?? null,
    payeeId: q.payeeName ? (payee.results[0]?.id ?? null) : null,
    tagIds,
    splitCategories: new Map(cats.results.map((c) => [c.id, c.name])),
    oldSplits: oldSplits?.results ?? [],
  };
}

/** Same checks and messages as validateTxReferences, from a lookupTx result. */
function checkRefs(refs: Row, accountId: string, type: string): void {
  if (!refs.account_ok) throw new HttpError(400, 'Account not found');
  if (!refs.category_ok) throw new HttpError(400, 'Category not found');
  if (!refs.method_ok) throw new HttpError(400, 'Payment method not found');
  if (refs.method_account !== accountId)
    throw new HttpError(400, 'Payment method does not belong to the selected account');
  if (refs.category_kind !== 'both' && refs.category_kind !== type)
    throw new HttpError(400, `Category is not valid for ${type} transactions`);
}

function checkRefundTarget(target: Row | null, type: string): void {
  if (!target) throw new HttpError(400, 'Refund target transaction not found');
  if (target.transaction_type !== 'expense')
    throw new HttpError(400, 'Refund target must be an expense');
  if (target.transfer_id) throw new HttpError(400, 'A transfer cannot be refunded');
  if (type !== 'income') throw new HttpError(400, 'A refund must be recorded as income');
}

type PreparedSplit = {
  id: string;
  categoryId: string | null;
  amount: number;
  description: string;
  note: string;
  occurredAt: string | null;
};

/** Parse split parts (amounts only); category existence is checked after the lookup. */
function parseSplits(raw: any[]): PreparedSplit[] {
  return raw.map((s) => {
    const amt = toMinorStrict(s.amount);
    if (!(amt > 0)) throw new HttpError(400, 'Each split amount must be greater than zero');
    return {
      id: id(),
      categoryId: optStr(s, 'categoryId'),
      amount: amt,
      description: str(s, 'description'),
      note: str(s, 'note'),
      occurredAt: optStr(s, 'occurredAt') ? toIso(s.occurredAt) : null,
    };
  });
}

function checkSplits(splits: PreparedSplit[], cats: Map<string, string>, total: number): void {
  for (const s of splits)
    if (s.categoryId && !cats.has(s.categoryId))
      throw new HttpError(400, 'Split category not found');
  const sum = splits.reduce((n, s) => n + s.amount, 0);
  if (Math.abs(sum - total) > 1) throw new HttpError(400, 'Split amounts must sum to the total');
}

function tagNamesOf(b: Record<string, unknown>): string[] {
  return [...new Set((b['tags'] as unknown[]).map((t) => String(t).trim()).filter(Boolean))];
}

/**
 * Statements linking `txId` to the named tags, creating missing tags first
 * (one per case-insensitive name, keeping the first spelling given).
 */
function tagLinkStmts(
  env: Env,
  txId: string,
  names: string[],
  existing: Map<string, string>,
  at: string
): { stmts: D1PreparedStatement[]; created: boolean } {
  const stmts: D1PreparedStatement[] = [];
  const ids = new Set<string>();
  let created = false;
  for (const n of names) {
    const k = n.toLowerCase();
    let tid = existing.get(k);
    if (!tid) {
      tid = id();
      existing.set(k, tid);
      created = true;
      stmts.push(
        env.DB.prepare('INSERT INTO tags (id,name,created_at,updated_at) VALUES (?,?,?,?)').bind(
          tid,
          n,
          at,
          at
        )
      );
    }
    ids.add(tid);
  }
  for (const tid of ids)
    stmts.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)'
      ).bind(txId, tid)
    );
  return { stmts, created };
}

function payeeInsert(env: Env, payeeId: string, name: string, at: string): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO payees (id,name,address,is_active,created_at,updated_at) VALUES (?,?,?,1,?,?)'
  ).bind(payeeId, name, '', at, at);
}

/**
 * Run a save's writes plus the read-back of the saved transaction (detail
 * shape) and every row the client must refresh. Returns the response body.
 */
async function writeAndReadBack(
  env: Env,
  writes: D1PreparedStatement[],
  txId: string,
  changedIds: (string | null | undefined)[],
  masterChanged: boolean
): Promise<Row> {
  const res = await batchAll(env, [
    ...writes,
    ...changedRowsStmts(env, changedIds),
    env.DB.prepare(SPLITS_OF).bind(txId),
    env.DB.prepare(REFUNDS_OF).bind(txId),
  ]);
  const [rows, tags, splits, refunds] = res.slice(-4);
  const affected = changedRows(rows, tags);
  const self = affected.find((t) => t.id === txId);
  if (!self) throw new HttpError(500, 'Saved transaction could not be read back');
  return {
    ...self,
    splits: splits.results,
    refunds: refunds.results,
    affected,
    masterChanged,
  };
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
  const categoryId = optStr(b, 'categoryId');
  const methodId = optStr(b, 'methodId');
  if (!categoryId) throw new HttpError(400, 'categoryId is required');
  if (!methodId) throw new HttpError(400, 'methodId is required');

  const refundsTransactionId = optStr(b, 'refundsTransactionId');
  const explicitPayeeId = optStr(b, 'payeeId');
  const payeeName = explicitPayeeId ? '' : str(b, 'payee');
  const status = STATUS_RE.test(str(b, 'status')) ? str(b, 'status') : 'cleared';
  const description = str(b, 'description');
  const note = str(b, 'note');
  const occurredAt = toIso(b['occurredAt']);
  const isSplitParent = b['isSplitParent'] === true;
  const splitsRaw = Array.isArray(b['splits']) ? (b['splits'] as any[]) : [];
  if (isSplitParent && splitsRaw.length < 2)
    throw new HttpError(400, 'A split needs at least two items');
  const splits = isSplitParent ? parseSplits(splitsRaw) : [];
  const tagNames = Array.isArray(b['tags']) ? tagNamesOf(b) : [];

  const lk = await lookupTx(env, {
    txId: null,
    accountId,
    methodId,
    categoryId,
    refundsTransactionId,
    payeeName,
    tagNames,
    splitCategoryIds: splits.map((s) => s.categoryId).filter((x): x is string => !!x),
    withOldSplits: false,
  });
  checkRefs(lk.refs, accountId, type);
  if (refundsTransactionId) checkRefundTarget(lk.refundTarget, type);
  if (isSplitParent) checkSplits(splits, lk.splitCategories, amountMinor);

  const txId = id();
  const writes: D1PreparedStatement[] = [];
  let masterChanged = false;
  let payeeId = explicitPayeeId;
  if (!payeeId && payeeName) {
    payeeId = lk.payeeId;
    if (!payeeId) {
      payeeId = id();
      writes.push(payeeInsert(env, payeeId, payeeName, at));
      masterChanged = true;
    }
  }
  const created: Row = {
    id: txId,
    account_id: accountId,
    payment_method_id: methodId,
    category_id: categoryId,
    payee_id: payeeId,
    transaction_type: type,
    amount_minor: amountMinor,
    occurred_at: occurredAt,
    description,
    note,
    status,
    parent_transaction_id: null,
    recurring_rule_id: null,
    transfer_id: null,
    is_split_parent: isSplitParent ? 1 : 0,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    refunds_transaction_id: refundsTransactionId,
  };
  writes.push(
    env.DB.prepare(INSERT_TX).bind(
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
      created.is_split_parent,
      at,
      at
    )
  );
  for (const s of splits)
    writes.push(
      env.DB.prepare(SPLIT_INSERT).bind(
        s.id,
        txId,
        s.categoryId,
        s.amount,
        s.description,
        s.note,
        s.occurredAt ?? occurredAt,
        at,
        at
      )
    );
  const tagWrites = tagLinkStmts(env, txId, tagNames, lk.tagIds, at);
  writes.push(...tagWrites.stmts);
  masterChanged ||= tagWrites.created;
  writes.push(...touchSuggestionStmts(env, description, at));
  writes.push(auditStmt(env, 'transaction', txId, 'create', null, created));

  const body = await writeAndReadBack(
    env,
    writes,
    txId,
    [txId, refundsTransactionId],
    masterChanged
  );
  return json(body, { status: 201 });
}

async function updateTransaction(env: Env, request: Request, txId: string): Promise<Response> {
  const b = await readJson(request);
  const at = now();
  const given = (k: string) => (b[k] !== undefined ? String(b[k] || '') : undefined);
  const splitsRaw = Array.isArray(b['splits']) ? (b['splits'] as any[]) : null;
  const tagNames = Array.isArray(b['tags']) ? tagNamesOf(b) : null;
  // Parse split amounts up front only to collect their categories for the lookup.
  const splitCategoryIds =
    splitsRaw && splitsRaw.length >= 2
      ? splitsRaw.map((s) => optStr(s, 'categoryId')).filter((x): x is string => !!x)
      : [];

  const lk = await lookupTx(env, {
    txId,
    accountId: b['accountId'] !== undefined ? String(b['accountId']) : undefined,
    methodId: given('methodId'),
    categoryId: given('categoryId'),
    refundsTransactionId:
      b['refundsTransactionId'] === null ? null : given('refundsTransactionId') || undefined,
    payeeName: b['payee'] !== undefined ? str(b, 'payee') : null,
    tagNames: tagNames || [],
    splitCategoryIds,
    withOldSplits: splitsRaw !== null,
  });
  const before = lk.before;
  if (!before) throw new HttpError(404, 'Transaction not found');
  if (before.transfer_id)
    throw new HttpError(400, 'Edit this transfer via PUT /api/transfers/:id instead');

  const amountMinor = b['amount'] !== undefined ? toMinorStrict(b['amount']) : before.amount_minor;
  const type = b['type'] !== undefined ? String(b['type']) : before.transaction_type;
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'type must be expense or income');
  if (!(amountMinor > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const accountId = b['accountId'] !== undefined ? String(b['accountId']) : before.account_id;
  const methodId = given('methodId') ?? before.payment_method_id;
  const categoryId = given('categoryId') ?? before.category_id;
  if (!methodId) throw new HttpError(400, 'methodId is required');
  if (!categoryId) throw new HttpError(400, 'categoryId is required');
  checkRefs(lk.refs, accountId, type);

  let payeeId =
    b['payeeId'] === null
      ? null
      : b['payeeId'] !== undefined
        ? String(b['payeeId'])
        : before.payee_id;
  const writes: D1PreparedStatement[] = [];
  let masterChanged = false;
  if (b['payee'] !== undefined) {
    const name = str(b, 'payee');
    payeeId = name ? lk.payeeId : null;
    if (name && !payeeId) {
      payeeId = id();
      writes.push(payeeInsert(env, payeeId, name, at));
      masterChanged = true;
    }
  }

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

  const refundsTransactionId =
    b['refundsTransactionId'] === null
      ? null
      : b['refundsTransactionId'] !== undefined
        ? String(b['refundsTransactionId'])
        : before.refunds_transaction_id;
  if (refundsTransactionId) {
    if (refundsTransactionId === txId)
      throw new HttpError(400, 'A transaction cannot refund itself');
    checkRefundTarget(lk.refundTarget, type);
  }

  // Validate replacement splits fully before writing anything.
  let newSplits: PreparedSplit[] | null = null;
  let isSplitParent = before.is_split_parent;
  if (splitsRaw) {
    if (splitsRaw.length >= 2) {
      newSplits = parseSplits(splitsRaw);
      checkSplits(newSplits, lk.splitCategories, amountMinor);
      isSplitParent = 1;
    } else {
      newSplits = [];
      isSplitParent = 0;
    }
  }

  writes.push(
    env.DB.prepare(
      `UPDATE transactions SET account_id=?,payment_method_id=?,category_id=?,payee_id=?,transaction_type=?,amount_minor=?,
       occurred_at=?,description=?,note=?,status=?,refunds_transaction_id=?,is_split_parent=?,updated_at=?
       WHERE id=?`
    ).bind(
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
      isSplitParent,
      at,
      txId
    )
  );

  let splitsAfter: Row[] | null = null;
  if (newSplits !== null) {
    writes.push(env.DB.prepare('DELETE FROM transaction_splits WHERE transaction_id=?').bind(txId));
    for (const s of newSplits)
      writes.push(
        env.DB.prepare(SPLIT_INSERT).bind(
          s.id,
          txId,
          s.categoryId,
          s.amount,
          s.description,
          s.note,
          s.occurredAt ?? occurredAt,
          at,
          at
        )
      );
    splitsAfter = newSplits.map((s) => ({
      category_id: s.categoryId,
      category_name: s.categoryId ? lk.splitCategories.get(s.categoryId) || null : null,
      amount_minor: s.amount,
      description: s.description,
      occurred_at: s.occurredAt ?? occurredAt,
    }));
  }

  if (tagNames) {
    writes.push(env.DB.prepare('DELETE FROM transaction_tags WHERE transaction_id=?').bind(txId));
    const tagWrites = tagLinkStmts(env, txId, tagNames, lk.tagIds, at);
    writes.push(...tagWrites.stmts);
    masterChanged ||= tagWrites.created;
  }

  if (description !== before.description) {
    writes.push(...untouchSuggestionStmts(env, before.description, at));
    writes.push(...touchSuggestionStmts(env, description, at));
  }

  const after: Row = {
    ...before,
    account_id: accountId,
    payment_method_id: methodId,
    category_id: categoryId,
    payee_id: payeeId,
    transaction_type: type,
    amount_minor: amountMinor,
    occurred_at: occurredAt,
    description,
    note,
    status,
    refunds_transaction_id: refundsTransactionId,
    is_split_parent: isSplitParent,
    updated_at: at,
  };
  const auditBefore: Row = newSplits ? { ...before, splits_summary: lk.oldSplits } : before;
  const auditAfter: Row = splitsAfter ? { ...after, splits_summary: splitsAfter } : after;
  writes.push(auditStmt(env, 'transaction', txId, 'update', auditBefore, auditAfter));

  const body = await writeAndReadBack(
    env,
    writes,
    txId,
    [txId, before.refunds_transaction_id, refundsTransactionId],
    masterChanged
  );
  return json(body);
}

/** Soft delete (moves to Trash). A transfer leg takes its other leg and transfer row with it. */
async function softDeleteTransaction(env: Env, txId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT * FROM transactions WHERE deleted_at IS NULL AND (id=? OR (transfer_id IS NOT NULL
       AND transfer_id=(SELECT transfer_id FROM transactions WHERE id=? AND deleted_at IS NULL)))`
  )
    .bind(txId, txId)
    .all<Row>();
  const target = rows.results.find((r) => r.id === txId);
  if (!target) throw new HttpError(404, 'Transaction not found');
  const sibling = target.transfer_id ? rows.results.find((r) => r.id !== txId) : undefined;
  const legs = sibling ? [target, sibling] : [target];
  const at = now();
  const writes: D1PreparedStatement[] = [];
  for (const leg of legs) {
    writes.push(
      env.DB.prepare('UPDATE transactions SET deleted_at=?, updated_at=? WHERE id=?').bind(
        at,
        at,
        leg.id
      ),
      ...untouchSuggestionStmts(env, leg.description, at),
      auditStmt(env, 'transaction', leg.id, 'delete', leg, { ...leg, deleted_at: at })
    );
  }
  if (target.transfer_id)
    writes.push(
      env.DB.prepare('UPDATE transfers SET deleted_at=?, updated_at=? WHERE id=?').bind(
        at,
        at,
        target.transfer_id
      )
    );
  const res = await batchAll(env, [
    ...writes,
    ...changedRowsStmts(
      env,
      legs.map((l) => l.refunds_transaction_id)
    ),
  ]);
  const [changed, tags] = res.slice(-2);
  return json({
    ok: true,
    removed: legs.map((l) => l.id),
    affected: changedRows(changed, tags),
  });
}

async function deleteTransaction(
  env: Env,
  txId: string,
  hard: boolean,
  cascaded = false
): Promise<Response> {
  if (!hard) return softDeleteTransaction(env, txId);
  const before = await env.DB.prepare('SELECT * FROM transactions WHERE id=?')
    .bind(txId)
    .first<Row>();
  if (!before) throw new HttpError(404, 'Transaction not found');
  const at = now();
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
  await untouchDescriptionSuggestion(env, before.description, at);
  await audit(env, 'transaction', txId, 'delete', before, null, { hard: true });
  if (!cascaded && before.transfer_id) {
    const sibling = await env.DB.prepare(
      'SELECT id FROM transactions WHERE transfer_id=? AND id<>?'
    )
      .bind(before.transfer_id, txId)
      .first<Row>();
    if (sibling) await deleteTransaction(env, sibling.id, true, true);
    await env.DB.prepare('DELETE FROM transfers WHERE id=?').bind(before.transfer_id).run();
  }
  return json({ ok: true });
}

async function restoreTransaction(env: Env, txId: string, cascaded = false): Promise<Response> {
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
  await touchDescriptionSuggestion(env, before.description, at);
  await audit(env, 'transaction', txId, 'restore', before, { ...before, deleted_at: null });
  if (!cascaded && before.transfer_id) {
    const sibling = await env.DB.prepare(
      'SELECT id FROM transactions WHERE transfer_id=? AND id<>? AND deleted_at IS NOT NULL'
    )
      .bind(before.transfer_id, txId)
      .first<Row>();
    if (sibling) await restoreTransaction(env, sibling.id, true);
    await env.DB.prepare('UPDATE transfers SET deleted_at=NULL, updated_at=? WHERE id=?')
      .bind(at, before.transfer_id)
      .run();
  }
  return json({ ok: true });
}

async function purgeAllTrash(env: Env): Promise<{ purged: number }> {
  const trashed = await env.DB.prepare(
    'SELECT id FROM transactions WHERE deleted_at IS NOT NULL'
  ).all<Row>();
  let purged = 0;
  for (const t of trashed.results) {
    // A prior iteration may have already purged this row via its sibling
    // transfer leg's cascade — skip it instead of erroring.
    const still = await env.DB.prepare('SELECT 1 AS ok FROM transactions WHERE id=?')
      .bind(t.id)
      .first<Row>();
    if (!still) continue;
    await deleteTransaction(env, t.id, true);
    purged++;
  }
  return { purged };
}

// ---------------- transfers ----------------
// A transfer moves money between two of the user's own accounts. It is
// stored as one `transfers` row (the source of truth for amount/date/
// description/note) plus two linked `transactions` rows sharing that
// transfer's id via `transfer_id`: an 'expense' leg on the source account
// and an 'income' leg on the destination account, each optionally with its
// own payment method (no category/payee — a transfer isn't categorized).
// Both legs count fully as real expense/income in every report/widget
// (rangeStats/categoryBreakdown/entityBreakdown), same as any other
// transaction — a transfer's source-account leg reduces that account's
// expense total, its destination-account leg adds to that account's
// income total. Category/payee breakdowns group transfer legs into a
// synthetic "Transfer" bucket (TRANSFER_BUCKET_ID) instead of
// "Uncategorized"/"No payee", since they have no real category or payee.
/** Same checks and messages as the old per-method lookup, from a prefetched method→account map. */
function checkMethod(
  methods: Map<string, string>,
  methodId: string | null,
  accountId: string
): void {
  if (!methodId) return;
  const owner = methods.get(methodId);
  if (owner === undefined) throw new HttpError(400, 'Payment method not found');
  if (owner !== accountId)
    throw new HttpError(400, 'Payment method does not belong to the selected account');
}

function methodAccounts(r: D1Result<Row>): Map<string, string> {
  return new Map(r.results.map((m) => [m.id, m.account_id]));
}

const METHODS_IN = `SELECT id, account_id FROM payment_methods WHERE deleted_at IS NULL
  AND id IN (SELECT value FROM json_each(?))`;

async function createTransfer(env: Env, request: Request): Promise<Response> {
  const b = await readJson(request);
  const at = now();
  const fromAccountId = str(b, 'fromAccountId');
  const toAccountId = str(b, 'toAccountId');
  const amountMinor = toMinorStrict(b['amount']);
  if (!fromAccountId) throw new HttpError(400, 'fromAccountId is required');
  if (!toAccountId) throw new HttpError(400, 'toAccountId is required');
  if (fromAccountId === toAccountId)
    throw new HttpError(400, 'From and to accounts must be different');
  if (!(amountMinor > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const fromMethodId = optStr(b, 'fromMethodId');
  const toMethodId = optStr(b, 'toMethodId');

  const [accs, methods] = await batchAll(env, [
    env.DB.prepare('SELECT id, name FROM accounts WHERE deleted_at IS NULL AND id IN (?,?)').bind(
      fromAccountId,
      toAccountId
    ),
    env.DB.prepare(METHODS_IN).bind(JSON.stringify([fromMethodId, toMethodId].filter(Boolean))),
  ]);
  const fromAcc = accs.results.find((a) => a.id === fromAccountId);
  const toAcc = accs.results.find((a) => a.id === toAccountId);
  if (!fromAcc) throw new HttpError(400, 'From account not found');
  if (!toAcc) throw new HttpError(400, 'To account not found');
  const owners = methodAccounts(methods);
  checkMethod(owners, fromMethodId, fromAccountId);
  checkMethod(owners, toMethodId, toAccountId);

  const status = STATUS_RE.test(str(b, 'status')) ? str(b, 'status') : 'cleared';
  const note = str(b, 'note');
  const occurredAt = toIso(b['occurredAt']);
  const customDescription = optStr(b, 'description');
  const outDescription = customDescription || `Transfer to ${toAcc.name}`;
  const inDescription = customDescription || `Transfer from ${fromAcc.name}`;

  const transferId = id();
  const outId = id();
  const inId = id();
  const transfer = {
    id: transferId,
    from_account_id: fromAccountId,
    to_account_id: toAccountId,
    amount_minor: amountMinor,
    occurred_at: occurredAt,
    description: customDescription || '',
    note,
    created_at: at,
    updated_at: at,
  };
  const leg = `INSERT INTO transactions
      (id,account_id,payment_method_id,category_id,payee_id,transaction_type,amount_minor,occurred_at,
       description,note,status,transfer_id,is_split_parent,created_at,updated_at)
     VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?,0,?,?)`;

  const res = await batchAll(env, [
    env.DB.prepare(
      `INSERT INTO transfers (id,from_account_id,to_account_id,amount_minor,occurred_at,description,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(
      transferId,
      fromAccountId,
      toAccountId,
      amountMinor,
      occurredAt,
      transfer.description,
      note,
      at,
      at
    ),
    env.DB.prepare(leg).bind(
      outId,
      fromAccountId,
      fromMethodId,
      'expense',
      amountMinor,
      occurredAt,
      outDescription,
      note,
      status,
      transferId,
      at,
      at
    ),
    env.DB.prepare(leg).bind(
      inId,
      toAccountId,
      toMethodId,
      'income',
      amountMinor,
      occurredAt,
      inDescription,
      note,
      status,
      transferId,
      at,
      at
    ),
    auditStmt(env, 'transfer', transferId, 'create', null, transfer),
    ...changedRowsStmts(env, [outId]),
    env.DB.prepare('SELECT * FROM transfers WHERE id=?').bind(transferId),
  ]);
  const [rows, tags, created] = res.slice(-3);
  return json({ ...created.results[0], affected: changedRows(rows, tags) }, { status: 201 });
}

async function updateTransfer(env: Env, request: Request, transferId: string): Promise<Response> {
  const b = await readJson(request);
  const at = now();
  const givenMethods = [
    b['fromMethodId'] !== undefined ? optStr(b, 'fromMethodId') : null,
    b['toMethodId'] !== undefined ? optStr(b, 'toMethodId') : null,
  ].filter(Boolean);
  const [tr, legRows, accs, methods] = await batchAll(env, [
    env.DB.prepare('SELECT * FROM transfers WHERE id=? AND deleted_at IS NULL').bind(transferId),
    env.DB.prepare('SELECT * FROM transactions WHERE transfer_id=? AND deleted_at IS NULL').bind(
      transferId
    ),
    env.DB.prepare(
      `SELECT a.id, a.name FROM accounts a JOIN transfers x ON a.id IN (x.from_account_id, x.to_account_id)
       WHERE x.id=?`
    ).bind(transferId),
    env.DB.prepare(
      `SELECT id, account_id FROM payment_methods WHERE deleted_at IS NULL
       AND (id IN (SELECT value FROM json_each(?))
         OR id IN (SELECT payment_method_id FROM transactions WHERE transfer_id=? AND deleted_at IS NULL))`
    ).bind(JSON.stringify(givenMethods), transferId),
  ]);
  const before = tr.results[0];
  if (!before) throw new HttpError(404, 'Transfer not found');
  if (legRows.results.length !== 2)
    throw new HttpError(500, 'Transfer is missing one of its two linked transactions');
  const outLeg = legRows.results.find((r) => r.transaction_type === 'expense');
  const inLeg = legRows.results.find((r) => r.transaction_type === 'income');
  if (!outLeg || !inLeg) throw new HttpError(500, 'Transfer legs are inconsistent');

  const amountMinor = b['amount'] !== undefined ? toMinorStrict(b['amount']) : before.amount_minor;
  if (!(amountMinor > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const occurredAt = b['occurredAt'] !== undefined ? toIso(b['occurredAt']) : before.occurred_at;
  const note = b['note'] !== undefined ? String(b['note']) : before.note;
  const status = STATUS_RE.test(str(b, 'status')) ? str(b, 'status') : outLeg.status;
  const customDescription =
    b['description'] !== undefined ? String(b['description']) : before.description;
  const fromMethodId =
    b['fromMethodId'] !== undefined ? optStr(b, 'fromMethodId') : outLeg.payment_method_id;
  const toMethodId =
    b['toMethodId'] !== undefined ? optStr(b, 'toMethodId') : inLeg.payment_method_id;
  const owners = methodAccounts(methods);
  checkMethod(owners, fromMethodId, before.from_account_id);
  checkMethod(owners, toMethodId, before.to_account_id);

  const names = new Map(accs.results.map((a) => [a.id, a.name]));
  const outDescription =
    customDescription || `Transfer to ${names.get(before.to_account_id) || ''}`;
  const inDescription =
    customDescription || `Transfer from ${names.get(before.from_account_id) || ''}`;
  const legUpdate =
    'UPDATE transactions SET amount_minor=?, occurred_at=?, description=?, note=?, status=?, payment_method_id=?, updated_at=? WHERE id=?';

  const res = await batchAll(env, [
    env.DB.prepare(
      'UPDATE transfers SET amount_minor=?, occurred_at=?, description=?, note=?, updated_at=? WHERE id=?'
    ).bind(amountMinor, occurredAt, customDescription, note, at, transferId),
    env.DB.prepare(legUpdate).bind(
      amountMinor,
      occurredAt,
      outDescription,
      note,
      status,
      fromMethodId,
      at,
      outLeg.id
    ),
    env.DB.prepare(legUpdate).bind(
      amountMinor,
      occurredAt,
      inDescription,
      note,
      status,
      toMethodId,
      at,
      inLeg.id
    ),
    auditStmt(env, 'transfer', transferId, 'update', before, {
      ...before,
      amount_minor: amountMinor,
      occurred_at: occurredAt,
      description: customDescription,
      note,
      updated_at: at,
    }),
    ...changedRowsStmts(env, [outLeg.id]),
    env.DB.prepare('SELECT * FROM transfers WHERE id=?').bind(transferId),
  ]);
  const [rows, tags, updated] = res.slice(-3);
  return json({ ...updated.results[0], affected: changedRows(rows, tags) });
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
  if (parentId) {
    // Walk up the new parent's ancestor chain — if we ever reach this
    // category's own id, the reassignment would create a cycle.
    let cursor: string | null = parentId;
    const seen = new Set<string>([idVal]);
    while (cursor) {
      if (seen.has(cursor))
        throw new HttpError(400, 'Cannot set parent: this would create a category cycle');
      seen.add(cursor);
      const row = await env.DB.prepare(
        'SELECT parent_id FROM categories WHERE id=? AND deleted_at IS NULL'
      )
        .bind(cursor)
        .first<Row>();
      cursor = row?.parent_id ?? null;
    }
  }
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
    'INSERT INTO payment_methods (id,account_id,name,is_active,created_at,updated_at) VALUES (?,?,?,1,?,?)'
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
  if (!/^(data:|https:)/i.test(url))
    throw new HttpError(400, 'Attachment url must be a data: URI or an https: link');
  const fileName = str(b, 'fileName');
  const mimeType =
    str(b, 'mimeType') || (kind === 'image' ? 'image/jpeg' : 'application/octet-stream');
  const sizeBytes =
    b['sizeBytes'] !== undefined && b['sizeBytes'] !== null ? asIntSafe(b['sizeBytes']) : null;
  if (sizeBytes !== null && (sizeBytes < 0 || sizeBytes > 5_000_000))
    throw new HttpError(400, 'sizeBytes must be between 0 and 5,000,000');
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
  if (!accountId) throw new HttpError(400, 'accountId is required');
  if (!TYPE_RE.test(type)) throw new HttpError(400, 'type must be expense or income');
  if (!(amount > 0)) throw new HttpError(400, 'amount must be greater than zero');
  if (!FREQ_RE.test(frequency)) throw new HttpError(400, 'invalid frequency');
  if (!(await exists(env, 'accounts', accountId))) throw new HttpError(400, 'Account not found');
  const categoryId =
    b['categoryId'] === null
      ? null
      : b['categoryId'] !== undefined
        ? String(b['categoryId'])
        : (defaults.category_id ?? null);
  const methodId =
    b['methodId'] === null
      ? null
      : b['methodId'] !== undefined
        ? String(b['methodId'])
        : (defaults.payment_method_id ?? null);
  if (categoryId && !(await exists(env, 'categories', categoryId)))
    throw new HttpError(400, 'Category not found');
  if (methodId && !(await exists(env, 'payment_methods', methodId)))
    throw new HttpError(400, 'Payment method not found');
  await checkTxReferences(env, accountId, methodId, categoryId, type);
  let payeeId =
    b['payeeId'] === null
      ? null
      : b['payeeId'] !== undefined
        ? String(b['payeeId'])
        : (defaults.payee_id ?? null);
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
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
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
  const insertResult = await env.DB.prepare(INSERT_TX_RECURRING_IDEMPOTENT)
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
      null,
      null,
      rule.id,
      0,
      at,
      at
    )
    .run();
  if (!insertResult.meta.changes)
    throw new HttpError(
      409,
      'A transaction for this due date was already generated (possibly by a concurrent request).'
    );
  const next = advanceDue(rule.next_due_at, rule.frequency, rule.interval_value);
  await env.DB.prepare(
    'UPDATE recurring_rules SET next_due_at=?, last_generated_at=?, updated_at=? WHERE id=?'
  )
    .bind(next, rule.next_due_at, at, idVal)
    .run();
  const createdTx = await env.DB.prepare('SELECT * FROM transactions WHERE id=?')
    .bind(txId)
    .first<Row>();
  await audit(env, 'transaction', txId, 'create', null, createdTx, { recurring: true });
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
  try {
    const backup = await exportJson(env);
    const res = await driveBackup(env, backup);
    return json(res);
  } catch (e) {
    await setDriveBackupError(env, e instanceof Error ? e.message : 'Backup failed').catch(
      () => {}
    );
    throw e;
  }
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
  const limit = clampInt(url.searchParams.get('limit'), 1, 300, 300);
  const before = url.searchParams.get('before');
  const beforeId = url.searchParams.get('beforeId');
  if (before || beforeId) {
    if (!before || !beforeId) throw new HttpError(400, 'Incomplete cursor');
    clauses.push('(occurred_at, id) < (?, ?)');
    params.push(before, beforeId);
  }
  if (entityType) {
    clauses.push('entity_type=?');
    params.push(entityType);
  }
  if (entityId) {
    clauses.push('entity_id=?');
    params.push(entityId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  // Strip embedded file payloads in SQL, including historical snapshots, so they
  // never travel from D1 to the Worker or browser. Keep the attachment metadata.
  const snapshot = (column: string) =>
    `CASE WHEN entity_type='attachment' AND json_valid(${column})
      THEN json_remove(${column}, '$.external_file_id', '$.url')
      ELSE ${column} END AS ${column}`;
  const r = await env.DB.prepare(
    `SELECT id, occurred_at, entity_type, entity_id, action,
      ${snapshot('before_json')}, ${snapshot('after_json')}, metadata_json
      FROM audit_log${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all<Row>();
  return json(r.results);
}

// ---------------- dispatcher ----------------
export async function route(request: Request, url: URL, env: Env): Promise<Response> {
  const p = url.pathname;
  const m = request.method;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','transactions','<id>']
  const res = (r: Response) => r;

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
    const accountId = url.searchParams.get('accountId');
    return res(json(await rangeStats(env, toIso(from), to ? toIso(to) : null, accountId)));
  }
  if (m === 'GET' && p === '/api/dashboard/categories') {
    const from = url.searchParams.get('from');
    if (!from) throw new HttpError(400, '"from" is required');
    const to = url.searchParams.get('to');
    const accountId = url.searchParams.get('accountId');
    const type = url.searchParams.get('type') === 'income' ? 'income' : 'expense';
    return res(
      json(await categoryBreakdown(env, toIso(from), to ? toIso(to) : null, { accountId, type }))
    );
  }
  if (m === 'GET' && p === '/api/dashboard/breakdown') {
    const from = url.searchParams.get('from');
    if (!from) throw new HttpError(400, '"from" is required');
    const by = url.searchParams.get('by');
    if (by !== 'method' && by !== 'payee') throw new HttpError(400, '"by" must be method or payee');
    const to = url.searchParams.get('to');
    const accountId = url.searchParams.get('accountId');
    const type = url.searchParams.get('type') === 'income' ? 'income' : 'expense';
    return res(
      json(await entityBreakdown(env, by, toIso(from), to ? toIso(to) : null, { accountId, type }))
    );
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
  if (p === '/api/transfers') {
    if (m === 'POST') return res(await createTransfer(env, request));
  }
  if (seg[1] === 'transfers' && seg[2]) {
    if (m === 'PUT') return res(await updateTransfer(env, request, seg[2]));
  }
  if (m === 'GET' && p === '/api/trash') return res(await listTransactions(env, url, true));
  if (m === 'POST' && p === '/api/trash/purge') return res(json(await purgeAllTrash(env)));

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
  // POST + session cookie (SameSite=Lax) means only the logged-in app can start a connection.
  if (m === 'POST' && p === '/api/drive/connect') {
    return res(json({ url: await driveAuthUrl(env, url) }));
  }
  if (m === 'GET' && p === '/api/drive/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const back = `${url.protocol}//${url.host}/manage/data?`;
    const failed = (message: string) =>
      res(
        textBody(
          driveCallbackHtml('error', `${back}drive=error`, message),
          'text/html; charset=utf-8'
        )
      );
    if (error) return failed('Google sign-in was cancelled.');
    if (!code) throw new HttpError(400, 'Missing authorization code.');
    try {
      await driveHandleCallback(env, url, code, state);
    } catch (e) {
      console.error('drive: OAuth callback failed', e);
      return failed(e instanceof HttpError ? e.message : 'Google Drive connection failed.');
    }
    return res(
      textBody(driveCallbackHtml('connected', `${back}drive=connected`), 'text/html; charset=utf-8')
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
