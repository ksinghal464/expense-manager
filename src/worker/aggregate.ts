import { Env } from './http';
import { periodStart, daysAgo } from '../shared/period';
import type { Dashboard, Account, DashboardFrame, CategoryTotal } from '../shared/types';

type Row = Record<string, any>;

/** Income/expense totals for transactions with occurred_at in [from, to). `to` null means "no upper bound". */
export async function rangeStats(
  env: Env,
  from: string,
  to: string | null
): Promise<{ income: number; expense: number; refunded: number }> {
  const clauses = ['deleted_at IS NULL', 'occurred_at >= ?'];
  const params: unknown[] = [from];
  if (to) {
    clauses.push('occurred_at < ?');
    params.push(to);
  }
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS expense,
       SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NULL THEN amount_minor ELSE 0 END) AS income,
       SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NOT NULL THEN amount_minor ELSE 0 END) AS refunded
     FROM transactions WHERE ${clauses.join(' AND ')}`
  )
    .bind(...params)
    .first<Row>();
  return { expense: r?.expense ?? 0, income: r?.income ?? 0, refunded: r?.refunded ?? 0 };
}

/**
 * Expense category breakdown for [from, to). Split transactions are broken
 * down by each split's own category rather than the parent row's category.
 */
export async function categoryBreakdown(
  env: Env,
  from: string,
  to: string | null
): Promise<CategoryTotal[]> {
  const toClauseA = to ? 'AND t.occurred_at < ?' : '';
  const toClauseB = to ? 'AND t.occurred_at < ?' : '';
  const params: unknown[] = to ? [from, to, from, to] : [from, from];
  const r = await env.DB.prepare(
    `SELECT id, name, SUM(total) AS total FROM (
       SELECT t.category_id AS id, COALESCE(c.name, 'Uncategorized') AS name, t.amount_minor AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.deleted_at IS NULL AND t.transaction_type='expense' AND t.is_split_parent=0
         AND t.occurred_at >= ? ${toClauseA}
       UNION ALL
       SELECT s.category_id AS id, COALESCE(c.name, 'Uncategorized') AS name, s.amount_minor AS total
       FROM transaction_splits s
       JOIN transactions t ON t.id = s.transaction_id
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE t.deleted_at IS NULL AND s.deleted_at IS NULL AND t.transaction_type='expense'
         AND t.is_split_parent=1 AND t.occurred_at >= ? ${toClauseB}
     )
     GROUP BY COALESCE(id, ''), name ORDER BY total DESC`
  )
    .bind(...params)
    .all<Row>();
  return r.results.map((row) => ({ id: row.id ?? null, name: row.name, total: row.total }));
}

const PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'ytd', label: 'This year (YTD)' },
];

function presetRange(key: string, nowMs: number): { from: string; to: string | null } {
  if (key === 'today') return { from: periodStart('day', nowMs), to: null };
  if (key === 'week') return { from: periodStart('week', nowMs), to: null };
  if (key === 'month') return { from: periodStart('month', nowMs), to: null };
  if (key === 'ytd') return { from: periodStart('year', nowMs), to: null };
  if (key === 'last30') return { from: daysAgo(30, nowMs), to: null };
  if (key === 'last12m') return { from: daysAgo(365, nowMs), to: null };
  return { from: periodStart('month', nowMs), to: null };
}

export async function buildDashboard(env: Env): Promise<Dashboard> {
  const nowMs = Date.now();

  const [frameStats, categories, accounts] = await Promise.all([
    Promise.all(PRESETS.map((p) => rangeStats(env, presetRange(p.key, nowMs).from, null))),
    categoryBreakdown(env, periodStart('month', nowMs), null),
    env.DB.prepare(
      `SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`
    ).all<Row>(),
  ]);

  const frames: DashboardFrame[] = PRESETS.map((p, i) => {
    const { from } = presetRange(p.key, nowMs);
    return { key: p.key, label: p.label, from, to: null, ...frameStats[i] };
  });

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
