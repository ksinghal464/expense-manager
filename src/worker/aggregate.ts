import { Env } from './http';
import { periodStart, PERIOD_PRESETS } from '../shared/period';
import type { Dashboard, Account, DashboardFrame, CategoryTotal } from '../shared/types';

type Row = Record<string, any>;

/** Income/expense totals for transactions with occurred_at in [from, to). `to` null means "no upper bound". */
export async function rangeStats(
  env: Env,
  from: string,
  to: string | null,
  accountId?: string | null
): Promise<{ income: number; expense: number; refunded: number }> {
  const clauses = ['deleted_at IS NULL', 'transfer_id IS NULL', 'occurred_at >= ?'];
  const params: unknown[] = [from];
  if (to) {
    clauses.push('occurred_at < ?');
    params.push(to);
  }
  if (accountId) {
    clauses.push('account_id = ?');
    params.push(accountId);
  }
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS grossExpense,
       SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NULL THEN amount_minor ELSE 0 END) AS income,
       SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NOT NULL THEN amount_minor ELSE 0 END) AS refunded
     FROM transactions WHERE ${clauses.join(' AND ')}`
  )
    .bind(...params)
    .first<Row>();
  const refunded = r?.refunded ?? 0;
  // Refunds net directly against expense (treated as "-expense") rather than being
  // folded into income, so the expense widget reflects the true out-of-pocket amount.
  const expense = (r?.grossExpense ?? 0) - refunded;
  return { expense, income: r?.income ?? 0, refunded };
}

/**
 * Category breakdown (expense or income) for [from, to), optionally scoped to
 * one account. Split transactions are broken down by each split's own
 * category rather than the parent row's category (splits only apply to
 * expenses, so income is never split).
 *
 * For expense breakdowns, refunds linked to an expense (via
 * refunds_transaction_id) are netted out of the refunded expense's
 * category/categories, so a category shows net spend (expense − refund)
 * rather than gross expense. A refund is netted in the period/account it
 * itself occurred in (matching rangeStats' income/refunded split), not the
 * period of the original expense. Refunds on split expenses are prorated
 * across the parent's splits proportionally to each split's share of the
 * parent amount. Income breakdowns exclude refund rows entirely (they're
 * never counted as income anywhere — see rangeStats) so a caller merging
 * income − expense into a "balance" figure doesn't double-count them.
 */
export async function categoryBreakdown(
  env: Env,
  from: string,
  to: string | null,
  opts: { accountId?: string | null; type?: 'expense' | 'income' } = {}
): Promise<CategoryTotal[]> {
  const type = opts.type === 'income' ? 'income' : 'expense';
  // Refunds are income-type rows too, but they're netted against expense (see
  // applyRefundAdjustments below) rather than counted as income — exclude them
  // here so they aren't double-counted when a caller merges income - expense
  // into a "balance" figure (see mergeBalance in Dashboard.tsx).
  const refundClauseA = type === 'income' ? 'AND t.refunds_transaction_id IS NULL' : '';
  const refundClauseB = type === 'income' ? 'AND t.refunds_transaction_id IS NULL' : '';
  const acctClauseA = opts.accountId ? 'AND t.account_id = ?' : '';
  const acctClauseB = opts.accountId ? 'AND t.account_id = ?' : '';
  const toClauseA = to ? 'AND t.occurred_at < ?' : '';
  const toClauseB = to ? 'AND t.occurred_at < ?' : '';
  const paramsA = [from, ...(to ? [to] : []), ...(opts.accountId ? [opts.accountId] : [])];
  const paramsB = [from, ...(to ? [to] : []), ...(opts.accountId ? [opts.accountId] : [])];
  const r = await env.DB.prepare(
    `SELECT id, name, SUM(total) AS total FROM (
       SELECT t.category_id AS id, COALESCE(c.name, 'Uncategorized') AS name, t.amount_minor AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.deleted_at IS NULL AND t.transaction_type='${type}' AND t.is_split_parent=0
         AND t.transfer_id IS NULL AND t.occurred_at >= ? ${toClauseA} ${acctClauseA} ${refundClauseA}
       UNION ALL
       SELECT s.category_id AS id, COALESCE(c.name, 'Uncategorized') AS name, s.amount_minor AS total
       FROM transaction_splits s
       JOIN transactions t ON t.id = s.transaction_id
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE t.deleted_at IS NULL AND s.deleted_at IS NULL AND t.transaction_type='${type}'
         AND t.is_split_parent=1 AND t.transfer_id IS NULL AND t.occurred_at >= ? ${toClauseB} ${acctClauseB} ${refundClauseB}
     )
     GROUP BY COALESCE(id, ''), name ORDER BY total DESC`
  )
    .bind(...paramsA, ...paramsB)
    .all<Row>();

  const totals = new Map<string, { id: string | null; name: string; total: number }>();
  for (const row of r.results) {
    totals.set(String(row.id ?? ''), { id: row.id ?? null, name: row.name, total: row.total });
  }

  if (type === 'expense') {
    await applyRefundAdjustments(env, from, to, opts.accountId ?? null, totals);
  }

  return [...totals.values()].sort((a, b) => b.total - a.total);
}

/**
 * Subtracts refunds (income transactions with refunds_transaction_id set)
 * from the category bucket(s) of the expense they refund, mutating `totals`
 * in place. A refund is counted in the period/account it itself occurred in.
 * Refunds on split expenses are prorated across the parent's splits
 * proportionally to each split's share of the parent amount, with the last
 * split absorbing any rounding remainder so the parts still sum exactly.
 */
async function applyRefundAdjustments(
  env: Env,
  from: string,
  to: string | null,
  accountId: string | null,
  totals: Map<string, { id: string | null; name: string; total: number }>
): Promise<void> {
  const clauses = [
    'r.deleted_at IS NULL',
    "r.transaction_type='income'",
    'r.refunds_transaction_id IS NOT NULL',
    't.deleted_at IS NULL',
    'r.occurred_at >= ?',
  ];
  const params: unknown[] = [from];
  if (to) {
    clauses.push('r.occurred_at < ?');
    params.push(to);
  }
  if (accountId) {
    clauses.push('r.account_id = ?');
    params.push(accountId);
  }
  const refunds = await env.DB.prepare(
    `SELECT r.amount_minor AS refund_amount, t.id AS parent_id, t.category_id AS parent_category_id,
       t.amount_minor AS parent_amount, t.is_split_parent AS parent_is_split
     FROM transactions r JOIN transactions t ON t.id = r.refunds_transaction_id
     WHERE ${clauses.join(' AND ')}`
  )
    .bind(...params)
    .all<Row>();
  if (!refunds.results.length) return;

  const splitParentIds = [
    ...new Set(
      refunds.results.filter((row) => row.parent_is_split).map((row) => String(row.parent_id))
    ),
  ];
  const splitsByParent = new Map<
    string,
    { category_id: string | null; name: string; amount_minor: number }[]
  >();
  if (splitParentIds.length) {
    const placeholders = splitParentIds.map(() => '?').join(',');
    const splitRows = await env.DB.prepare(
      `SELECT s.transaction_id AS parent_id, s.category_id, COALESCE(c.name, 'Uncategorized') AS name, s.amount_minor
       FROM transaction_splits s LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.deleted_at IS NULL AND s.transaction_id IN (${placeholders})`
    )
      .bind(...splitParentIds)
      .all<Row>();
    for (const row of splitRows.results) {
      const key = String(row.parent_id);
      if (!splitsByParent.has(key)) splitsByParent.set(key, []);
      splitsByParent.get(key)!.push({
        category_id: row.category_id ?? null,
        name: row.name,
        amount_minor: row.amount_minor,
      });
    }
  }

  const subtract = (id: string | null, name: string, amount: number) => {
    if (!amount) return;
    const key = String(id ?? '');
    const existing = totals.get(key);
    if (existing) existing.total -= amount;
    else totals.set(key, { id, name, total: -amount });
  };

  for (const row of refunds.results) {
    const refundAmount: number = row.refund_amount;
    if (!row.parent_is_split) {
      subtract(row.parent_category_id ?? null, 'Uncategorized', refundAmount);
      continue;
    }
    const splits = splitsByParent.get(String(row.parent_id)) || [];
    const parentAmount: number = row.parent_amount || 1;
    if (!splits.length) continue;
    let allocated = 0;
    splits.forEach((s, i) => {
      const share =
        i === splits.length - 1
          ? refundAmount - allocated
          : Math.round((refundAmount * s.amount_minor) / parentAmount);
      allocated += share;
      subtract(s.category_id, s.name, share);
    });
  }
}

/**
 * Payment-method or payee breakdown (expense or income) for [from, to),
 * optionally scoped to one account. Unlike categories, methods/payees are
 * plain transaction-level attributes (splits don't carry their own), so a
 * single grouped query is enough. For expense breakdowns, refunds are
 * netted out of the refunded expense's own method/payee bucket (see
 * categoryBreakdown for the period/account semantics of when a refund is
 * counted); income breakdowns exclude refund rows entirely so they aren't
 * double-counted when a caller (e.g. mergeBalance in Dashboard.tsx) derives
 * a balance as income − expense.
 */
export async function entityBreakdown(
  env: Env,
  dimension: 'method' | 'payee',
  from: string,
  to: string | null,
  opts: { accountId?: string | null; type?: 'expense' | 'income' } = {}
): Promise<CategoryTotal[]> {
  const type = opts.type === 'income' ? 'income' : 'expense';
  const idCol = dimension === 'method' ? 't.payment_method_id' : 't.payee_id';
  const joinTable = dimension === 'method' ? 'payment_methods' : 'payees';
  const joinAlias = dimension === 'method' ? 'pm' : 'py';
  const fallbackName = dimension === 'method' ? 'No payment method' : 'No payee';
  const clauses = [
    `t.deleted_at IS NULL`,
    `t.transaction_type='${type}'`,
    't.transfer_id IS NULL',
    't.occurred_at >= ?',
  ];
  const params: unknown[] = [from];
  if (type === 'income') {
    // Refunds are income-type rows but are netted against expense instead of
    // counted as income (see the refund-adjustment block below) — exclude
    // them here so mergeBalance (Dashboard.tsx) doesn't double-count them.
    clauses.push('t.refunds_transaction_id IS NULL');
  }
  if (to) {
    clauses.push('t.occurred_at < ?');
    params.push(to);
  }
  if (opts.accountId) {
    clauses.push('t.account_id = ?');
    params.push(opts.accountId);
  }
  const r = await env.DB.prepare(
    `SELECT ${idCol} AS id, COALESCE(${joinAlias}.name, '${fallbackName}') AS name, SUM(t.amount_minor) AS total
     FROM transactions t LEFT JOIN ${joinTable} ${joinAlias} ON ${joinAlias}.id = ${idCol}
     WHERE ${clauses.join(' AND ')}
     GROUP BY COALESCE(${idCol}, ''), name ORDER BY total DESC`
  )
    .bind(...params)
    .all<Row>();

  const totals = new Map<string, { id: string | null; name: string; total: number }>();
  for (const row of r.results) {
    totals.set(String(row.id ?? ''), { id: row.id ?? null, name: row.name, total: row.total });
  }

  if (type === 'expense') {
    const idColParent = dimension === 'method' ? 't.payment_method_id' : 't.payee_id';
    const clauses2 = [
      'r.deleted_at IS NULL',
      "r.transaction_type='income'",
      'r.refunds_transaction_id IS NOT NULL',
      't.deleted_at IS NULL',
      'r.occurred_at >= ?',
    ];
    const params2: unknown[] = [from];
    if (to) {
      clauses2.push('r.occurred_at < ?');
      params2.push(to);
    }
    if (opts.accountId) {
      clauses2.push('r.account_id = ?');
      params2.push(opts.accountId);
    }
    const refunds = await env.DB.prepare(
      `SELECT r.amount_minor AS refund_amount, ${idColParent} AS id,
         COALESCE(${joinAlias}.name, '${fallbackName}') AS name
       FROM transactions r
       JOIN transactions t ON t.id = r.refunds_transaction_id
       LEFT JOIN ${joinTable} ${joinAlias} ON ${joinAlias}.id = ${idColParent}
       WHERE ${clauses2.join(' AND ')}`
    )
      .bind(...params2)
      .all<Row>();
    for (const row of refunds.results) {
      const key = String(row.id ?? '');
      const existing = totals.get(key);
      if (existing) existing.total -= row.refund_amount;
      else totals.set(key, { id: row.id ?? null, name: row.name, total: -row.refund_amount });
    }
  }

  return [...totals.values()].sort((a, b) => b.total - a.total);
}

// The dashboard's default (bootstrap) frames are just today/week/month/YTD —
// last30/last12m/all are only ever requested on demand via /api/dashboard/frame
// with an explicit `from`, so they don't need a seeded default frame here.
const DEFAULT_DASHBOARD_PRESET_KEYS = new Set(['today', 'week', 'month', 'ytd']);
const DASHBOARD_PRESETS = PERIOD_PRESETS.filter((p) => DEFAULT_DASHBOARD_PRESET_KEYS.has(p.key));

export async function buildDashboard(env: Env): Promise<Dashboard> {
  const nowMs = Date.now();

  const [frameStats, categories, accounts] = await Promise.all([
    Promise.all(DASHBOARD_PRESETS.map((p) => rangeStats(env, p.from(nowMs), null))),
    categoryBreakdown(env, periodStart('month', nowMs), null),
    env.DB.prepare(
      `SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`
    ).all<Row>(),
  ]);

  const frames: DashboardFrame[] = DASHBOARD_PRESETS.map((p, i) => ({
    key: p.key,
    label: p.label,
    from: p.from(nowMs),
    to: null,
    ...frameStats[i],
  }));

  const balances = await Promise.all(
    accounts.results.map((a) =>
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN transaction_type='income' THEN amount_minor ELSE 0 END) AS inc,
           SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS exp
         FROM transactions WHERE deleted_at IS NULL AND account_id=?`
      )
        .bind(a.id)
        .first<Row>()
        .then((f) => ({
          ...(a as Account),
          balance_minor: a.opening_balance_minor + (f?.inc ?? 0) - (f?.exp ?? 0),
        }))
    )
  );

  return { frames, categories, balances };
}
