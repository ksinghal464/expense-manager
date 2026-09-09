import { Env, HttpError } from './http';
import { audit, id, now, runBatches } from './db';
import { parseImportCsv, normalizeRows, groupRows, csvEscape, NormImportRow } from '../shared/csv';
import { toISTDate, parseDDMMYYYY } from '../shared/period';
import type { ImportSummary } from '../shared/types';

type Row = Record<string, any>;

function kindForTop(name: string): 'expense' | 'income' | 'both' {
  const n = name.trim().toLowerCase();
  if (n === 'income') return 'income';
  if (n === 'uncategorized') return 'both';
  return 'expense';
}

/**
 * Import a legacy CSV. "replace" hard-clears existing data first; "append"
 * reuses existing master data and only adds new transactions.
 */
export async function importCsv(
  env: Env,
  text: string,
  mode: 'append' | 'replace' = 'append'
): Promise<ImportSummary> {
  const { rows, errors } = parseImportCsv(text);
  if (rows.length === 0)
    throw new HttpError(400, errors[0]?.message || 'No data rows found in CSV.');

  if (mode === 'replace') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM transaction_tags'),
      env.DB.prepare('DELETE FROM transaction_splits'),
      env.DB.prepare('DELETE FROM notes'),
      env.DB.prepare('DELETE FROM attachments'),
      env.DB.prepare('DELETE FROM audit_log'),
      env.DB.prepare('DELETE FROM transactions'),
      env.DB.prepare('DELETE FROM description_suggestions'),
      env.DB.prepare('DELETE FROM tags'),
      env.DB.prepare('DELETE FROM payees'),
      env.DB.prepare('DELETE FROM payment_methods'),
      env.DB.prepare('DELETE FROM categories'),
      env.DB.prepare('DELETE FROM recurring_rules'),
      env.DB.prepare('DELETE FROM accounts'),
    ]);
  }

  const at = now();
  const summary: ImportSummary = {
    inserted: 0,
    accounts: 0,
    categories: 0,
    payees: 0,
    methods: 0,
    errors: [],
  };
  const norm = normalizeRows(rows);

  // ---- cached master upserts ----
  const acc = new Map<string, string>();
  const pm = new Map<string, string>();
  const catTop = new Map<string, string>();
  const catSub = new Map<string, string>();
  const pay = new Map<string, string>();
  const tag = new Map<string, string>();

  const ensureAccount = async (name: string): Promise<string | null> => {
    const key = name.trim().toLowerCase();
    if (!key) return null;
    if (acc.has(key)) return acc.get(key)!;
    let r = await env.DB.prepare(
      'SELECT id FROM accounts WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1'
    )
      .bind(key)
      .first<Row>();
    if (!r) {
      const newId = id();
      await env.DB.prepare(
        `INSERT INTO accounts (id,name,currency,opening_balance_minor,opening_balance_at,is_active,created_at,updated_at)
         VALUES (?,?,?,0,?,1,?,?)`
      )
        .bind(newId, name.trim(), 'INR', at, at, at)
        .run();
      summary.accounts++;
      r = { id: newId };
    }
    acc.set(key, r.id);
    return r.id;
  };

  const ensureMethod = async (accountId: string | null, name: string): Promise<string | null> => {
    const n = name.trim();
    if (!n || !accountId) return null;
    const key = accountId + '|' + n.toLowerCase();
    if (pm.has(key)) return pm.get(key)!;
    let r = await env.DB.prepare(
      'SELECT id FROM payment_methods WHERE account_id=? AND lower(name)=? AND deleted_at IS NULL LIMIT 1'
    )
      .bind(accountId, n.toLowerCase())
      .first<Row>();
    if (!r) {
      const newId = id();
      await env.DB.prepare(
        `INSERT INTO payment_methods (id,account_id,name,is_active,created_at,updated_at) VALUES (?,?,?,?,1,?)`
      )
        .bind(newId, accountId, n, at, at)
        .run();
      summary.methods++;
      r = { id: newId };
    }
    pm.set(key, r.id);
    return r.id;
  };

  const ensureCategory = async (topName: string, subName: string): Promise<string | null> => {
    const top = (topName || 'Uncategorized').trim();
    const topKey = top.toLowerCase();
    if (!catTop.has(topKey)) {
      let r = await env.DB.prepare(
        'SELECT id FROM categories WHERE parent_id IS NULL AND lower(name)=? AND deleted_at IS NULL LIMIT 1'
      )
        .bind(topKey)
        .first<Row>();
      if (!r) {
        const newId = id();
        await env.DB.prepare(
          `INSERT INTO categories (id,name,parent_id,kind,sort_order,is_active,created_at,updated_at)
           VALUES (?,?,NULL,?,0,1,?,?)`
        )
          .bind(newId, top, kindForTop(top), at, at)
          .run();
        summary.categories++;
        r = { id: newId };
      }
      catTop.set(topKey, r.id);
    }
    const topId = catTop.get(topKey)!;
    const sub = subName.trim();
    if (!sub) return topId;
    const subKey = topKey + '|' + sub.toLowerCase();
    if (catSub.has(subKey)) return catSub.get(subKey)!;
    let r = await env.DB.prepare(
      'SELECT id FROM categories WHERE parent_id=? AND lower(name)=? AND deleted_at IS NULL LIMIT 1'
    )
      .bind(topId, sub.toLowerCase())
      .first<Row>();
    if (!r) {
      const newId = id();
      await env.DB.prepare(
        `INSERT INTO categories (id,name,parent_id,kind,sort_order,is_active,created_at,updated_at)
         VALUES (?,?,?,?,0,1,?,?)`
      )
        .bind(newId, sub, topId, catTopKind(top), at, at)
        .run();
      summary.categories++;
      r = { id: newId };
    }
    catSub.set(subKey, r.id);
    return r.id;
  };
  const catTopKind = (top: string) => (kindForTop(top) === 'income' ? 'income' : 'expense');

  const ensurePayee = async (name: string): Promise<string | null> => {
    const n = name.trim();
    if (!n) return null;
    const key = n.toLowerCase();
    if (pay.has(key)) return pay.get(key)!;
    let r = await env.DB.prepare(
      'SELECT id FROM payees WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1'
    )
      .bind(key)
      .first<Row>();
    if (!r) {
      const newId = id();
      await env.DB.prepare(
        `INSERT INTO payees (id,name,address,is_active,created_at,updated_at) VALUES (?,?,?,1,?,?)`
      )
        .bind(newId, n, '', at, at)
        .run();
      summary.payees++;
      r = { id: newId };
    }
    pay.set(key, r.id);
    return r.id;
  };

  const ensureTag = async (name: string): Promise<string | null> => {
    const n = name.trim();
    if (!n) return null;
    const key = n.toLowerCase();
    if (tag.has(key)) return tag.get(key)!;
    let r = await env.DB.prepare(
      'SELECT id FROM tags WHERE lower(name)=? AND deleted_at IS NULL LIMIT 1'
    )
      .bind(key)
      .first<Row>();
    if (!r) {
      const newId = id();
      await env.DB.prepare(`INSERT INTO tags (id,name,created_at,updated_at) VALUES (?,?,?,?)`)
        .bind(newId, n, at, at)
        .run();
      r = { id: newId };
    }
    tag.set(key, r.id);
    return r.id;
  };

  // ---- build per-row context (creates master data, caches ids) ----
  interface Ctx {
    accountId: string | null;
    methodId: string | null;
    categoryId: string | null;
    payeeId: string | null;
    tagIds: string[];
  }
  const ctxs: Ctx[] = new Array(norm.length);
  for (let i = 0; i < norm.length; i++) {
    const n = norm[i];
    const accountId = await ensureAccount(n.account);
    const methodId = await ensureMethod(accountId, n.payment_method);
    const categoryId = await ensureCategory(n.category, n.subcategory);
    const payeeId = await ensurePayee(n.payee);
    const tagIds: string[] = [];
    for (const t of n.tag.split(',')) {
      const tid = await ensureTag(t);
      if (tid) tagIds.push(tid);
    }
    ctxs[i] = { accountId, methodId, categoryId, payeeId, tagIds };
  }

  // ---- build transaction inserts ----
  interface TxIn {
    id: string;
    ctx: Ctx;
    row: NormImportRow;
    refundsTxId: string | null;
    isSplitParent: number;
    splits?: { id: string; categoryId: string | null; amount: number; description: string }[];
    amountMinor: number;
    type: 'expense' | 'income';
  }
  const txs: TxIn[] = [];
  const groups = groupRows(norm);
  const idxByRow = new Map<NormImportRow, number>();
  norm.forEach((n, i) => idxByRow.set(n, i));

  const mk = (row: NormImportRow, overrides: Partial<TxIn> = {}): TxIn => {
    const ctx = ctxs[idxByRow.get(row)!];
    return {
      id: id(),
      ctx,
      row,
      amountMinor: row.amount_minor,
      type: row.type,
      refundsTxId: null,
      isSplitParent: 0,
      ...overrides,
    };
  };

  for (const g of groups) {
    const negatives = g.rows.filter((r) => r.type === 'expense');
    const positives = g.rows.filter((r) => r.type === 'income');
    if (g.group == null) {
      txs.push(mk(g.rows[0]));
    } else if (negatives.length >= 1 && positives.length >= 1) {
      // original expense + refund(s)
      const parentRow = negatives.reduce((a, b) => (a.amount_minor >= b.amount_minor ? a : b));
      const parent = mk(parentRow, { id: id() });
      txs.push(parent);
      for (const pos of positives) txs.push(mk(pos, { refundsTxId: parent.id }));
      for (const extra of negatives.filter((r) => r !== parentRow)) txs.push(mk(extra));
    } else if (negatives.length >= 1 && positives.length === 0) {
      // bill split -> one split parent + children
      const first = negatives[0];
      const total = negatives.reduce((s, r) => s + r.amount_minor, 0);
      const ctx = ctxs[idxByRow.get(first)!];
      const splits = negatives.map((r) => ({
        id: id(),
        categoryId: ctxs[idxByRow.get(r)!].categoryId,
        amount: r.amount_minor,
        description: r.description,
      }));
      txs.push({
        id: id(),
        ctx,
        row: first,
        amountMinor: total,
        type: 'expense',
        refundsTxId: null,
        isSplitParent: 1,
        splits,
      });
    } else {
      for (const p of positives) txs.push(mk(p));
    }
  }

  // ---- batch insert ----
  const txStmts: D1PreparedStatement[] = [];
  const splitStmts: D1PreparedStatement[] = [];
  const tagStmts: D1PreparedStatement[] = [];
  for (const t of txs) {
    const txId = t.id;
    const r = t.row;
    const occurredAt = parseDDMMYYYY(r.date) || at;
    const status = r.status.trim().toLowerCase() === 'uncleared' ? 'uncleared' : 'cleared';
    txStmts.push(
      env.DB.prepare(
        `INSERT INTO transactions
           (id,account_id,payment_method_id,category_id,payee_id,transaction_type,amount_minor,occurred_at,
            description,note,status,refunds_transaction_id,
            parent_transaction_id,recurring_rule_id,is_split_parent,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        txId,
        t.ctx.accountId,
        t.ctx.methodId,
        t.ctx.categoryId,
        t.ctx.payeeId,
        t.type,
        t.amountMinor,
        occurredAt,
        r.description,
        '',
        status,
        t.refundsTxId,
        null,
        null,
        t.isSplitParent,
        at,
        at
      )
    );
    for (const tid of t.ctx.tagIds)
      tagStmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO transaction_tags (transaction_id,tag_id) VALUES (?,?)'
        ).bind(txId, tid)
      );
    if (t.splits) {
      for (const s of t.splits) {
        splitStmts.push(
          env.DB.prepare(
            `INSERT INTO transaction_splits (id,transaction_id,category_id,amount_minor,description,note,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)`
          ).bind(s.id, txId, s.categoryId, s.amount, s.description, '', at, at)
        );
      }
    }
  }

  if (txStmts.length) await runBatches(env, txStmts);
  if (splitStmts.length) await runBatches(env, splitStmts);
  if (tagStmts.length) await runBatches(env, tagStmts);

  summary.inserted = txs.length;
  await audit(
    env,
    'import',
    'csv',
    'create',
    null,
    { mode, rows: norm.length, inserted: txs.length },
    { mode, errors }
  );
  return summary;
}

function toMinorSafe(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Export transactions as a clean, re-importable CSV. */
export async function exportCsv(
  env: Env,
  opts: { type?: string; from?: string; to?: string } = {}
): Promise<string> {
  const clauses = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (opts.type === 'income' || opts.type === 'expense') {
    clauses.push('t.transaction_type=?');
    params.push(opts.type);
  }
  if (opts.from) {
    clauses.push('t.occurred_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push('t.occurred_at <= ?');
    params.push(opts.to);
  }
  const rows = await env.DB.prepare(
    `SELECT t.*, c.name AS category_name, cp.name AS parent_category_name, p.name AS payee_name,
            pm.name AS method_name, a.name AS account_name,
            (SELECT group_concat(tg.name, ', ') FROM transaction_tags tt JOIN tags tg ON tg.id=tt.tag_id
              WHERE tt.transaction_id=t.id) AS tags
     FROM transactions t
     JOIN accounts a ON a.id=t.account_id
     LEFT JOIN categories c ON c.id=t.category_id
     LEFT JOIN categories cp ON cp.id=c.parent_id
     LEFT JOIN payees p ON p.id=t.payee_id
     LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY t.occurred_at DESC, t.created_at DESC`
  )
    .bind(...params)
    .all<Row>();

  const header = [
    'Date',
    'Amount',
    'Category',
    'Subcategory',
    'Payment Method',
    'Description',
    'Payee/Payer',
    'Status',
    'Account',
    'Tag',
    'Type',
  ];
  const lines = [header.join(',')];
  for (const r of rows.results) {
    const amount = (r.transaction_type === 'expense' ? -r.amount_minor : r.amount_minor) / 100;
    const amountStr = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
    const cat = r.parent_category_name || r.category_name || '';
    const sub = r.parent_category_name ? r.category_name || '' : '';
    const line = [
      toISTDate(r.occurred_at),
      amountStr,
      cat,
      sub,
      r.method_name || '',
      r.description || '',
      r.payee_name || '',
      r.status,
      r.account_name || '',
      r.tags || '',
      r.transaction_type,
    ]
      .map(csvEscape)
      .join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

/** Full JSON backup/restore payload (non-deleted rows only). */
export async function exportJson(env: Env) {
  const q = (sql: string) =>
    env.DB.prepare(sql)
      .all<Row>()
      .then((r) => r.results);
  const [
    accounts,
    categories,
    paymentMethods,
    payees,
    tags,
    transactions,
    splits,
    notes,
    recurring,
    transactionTags,
    attachments,
  ] = await Promise.all([
    q('SELECT * FROM accounts WHERE deleted_at IS NULL'),
    q('SELECT * FROM categories WHERE deleted_at IS NULL'),
    q('SELECT * FROM payment_methods WHERE deleted_at IS NULL'),
    q('SELECT * FROM payees WHERE deleted_at IS NULL'),
    q('SELECT * FROM tags WHERE deleted_at IS NULL'),
    q('SELECT * FROM transactions WHERE deleted_at IS NULL'),
    q('SELECT * FROM transaction_splits WHERE deleted_at IS NULL'),
    q('SELECT * FROM notes WHERE deleted_at IS NULL'),
    q('SELECT * FROM recurring_rules WHERE deleted_at IS NULL'),
    q('SELECT transaction_id, tag_id FROM transaction_tags'),
    q('SELECT * FROM attachments WHERE deleted_at IS NULL'),
  ]);
  return {
    schema: 'expense-manager/1',
    exportedAt: now(),
    data: {
      accounts,
      categories,
      paymentMethods,
      payees,
      tags,
      transactions,
      splits,
      notes,
      recurring,
      transactionTags,
      attachments,
    },
  };
}

const RESTORE_ORDER: [string, string[]][] = [
  [
    'accounts',
    [
      'id',
      'name',
      'currency',
      'opening_balance_minor',
      'opening_balance_at',
      'is_active',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  [
    'categories',
    [
      'id',
      'name',
      'parent_id',
      'kind',
      'sort_order',
      'is_active',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  [
    'payment_methods',
    ['id', 'account_id', 'name', 'is_active', 'created_at', 'updated_at', 'deleted_at'],
  ],
  ['payees', ['id', 'name', 'address', 'is_active', 'created_at', 'updated_at', 'deleted_at']],
  ['tags', ['id', 'name', 'created_at', 'updated_at', 'deleted_at']],
  [
    'recurring_rules',
    [
      'id',
      'name',
      'transaction_type',
      'account_id',
      'payment_method_id',
      'category_id',
      'payee_id',
      'amount_minor',
      'description',
      'note',
      'frequency',
      'interval_value',
      'no_of_payments',
      'next_due_at',
      'is_active',
      'last_generated_at',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  [
    'transactions',
    [
      'id',
      'account_id',
      'payment_method_id',
      'category_id',
      'payee_id',
      'transaction_type',
      'amount_minor',
      'occurred_at',
      'description',
      'note',
      'status',
      'refunds_transaction_id',
      'parent_transaction_id',
      'recurring_rule_id',
      'is_split_parent',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  [
    'transaction_splits',
    [
      'id',
      'transaction_id',
      'category_id',
      'amount_minor',
      'description',
      'note',
      'occurred_at',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  ['transaction_tags', ['transaction_id', 'tag_id']],
  [
    'notes',
    [
      'id',
      'transaction_id',
      'title',
      'content',
      'reminder_at',
      'is_done',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
  [
    'attachments',
    [
      'id',
      'transaction_id',
      'provider',
      'external_file_id',
      'file_name',
      'mime_type',
      'size_bytes',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  ],
];

/** Full replace-restore from a backup JSON (must match schema "expense-manager/1"). */
export async function restoreBackup(env: Env, backup: any): Promise<{ restored: number }> {
  if (!backup || backup.schema !== 'expense-manager/1' || !backup.data) {
    throw new HttpError(
      400,
      'Invalid backup: expected schema "expense-manager/1" with a data payload.'
    );
  }
  const data = backup.data;
  // clear everything (child tables first)
  await env.DB.batch(RESTORE_ORDER.map(([t]) => env.DB.prepare(`DELETE FROM ${t}`)));
  let restored = 0;
  for (const [table, cols] of RESTORE_ORDER) {
    const rows: Row[] = Array.isArray(data[table]) ? data[table] : [];
    const stmts: D1PreparedStatement[] = [];
    for (const row of rows) {
      const present = cols.filter((c) => row[c] !== undefined);
      const vals = present.map((c) => row[c] ?? null);
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO ${table} (${present.join(',')}) VALUES (${present.map(() => '?').join(',')})`
        ).bind(...vals)
      );
      restored++;
    }
    if (stmts.length) await runBatches(env, stmts);
  }
  await audit(env, 'import', 'backup', 'create', null, { restored });
  return { restored };
}
