import { Env } from './http';
import { periodStart } from '../shared/period';
import type { Dashboard, Account } from '../shared/types';

type Row = Record<string, any>;

/**
 * Compute the dashboard summary in SQL. Period boundaries are computed in
 * IST (fixed +05:30) and compared against occurred_at (UTC ISO) lexicographically.
 * Refunds (income rows linked via refunds_transaction_id) are excluded from the
 * "income" KPI but still count toward account balances.
 */
export async function buildDashboard(env: Env): Promise<Dashboard> {
  const nowMs = Date.now();
  const week = periodStart('week', nowMs);
  const month = periodStart('month', nowMs);
  const ytd = periodStart('year', nowMs);

  const range = async (start: string) => {
    const r = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS expense,
         SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NULL THEN amount_minor ELSE 0 END) AS income,
         SUM(CASE WHEN transaction_type='income' AND refunds_transaction_id IS NOT NULL THEN amount_minor ELSE 0 END) AS refunded
       FROM transactions WHERE deleted_at IS NULL AND occurred_at >= ?`,
    )
      .bind(start)
      .first<Row>();
    return {
      expense: r?.expense ?? 0,
      income: r?.income ?? 0,
      refunded: r?.refunded ?? 0,
    };
  };

  const [weekS, monthS, ytdS, catRows, accounts] = await Promise.all([
    range(week),
    range(month),
    range(ytd),
    env.DB.prepare(
      `SELECT COALESCE(c.name, 'Uncategorized') AS name, SUM(t.amount_minor) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.deleted_at IS NULL AND t.transaction_type='expense' AND t.occurred_at >= ?
       GROUP BY COALESCE(c.id, 0) ORDER BY total DESC`,
    )
      .bind(month)
      .all<Row>(),
    env.DB.prepare(
      `SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`,
    ).all<Row>(),
  ]);

  const balances = await Promise.all(
    accounts.results.map((a) =>
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN transaction_type='income' THEN amount_minor ELSE 0 END) AS inc,
           SUM(CASE WHEN transaction_type='expense' THEN amount_minor ELSE 0 END) AS exp
         FROM transactions WHERE deleted_at IS NULL AND account_id=?`,
      )
        .bind(a.id)
        .first<Row>()
        .then((f) => ({
          ...(a as Account),
          balance_minor: a.opening_balance_minor + (f?.inc ?? 0) - (f?.exp ?? 0),
        })),
    ),
  );

  const categories: Record<string, number> = {};
  for (const c of catRows.results) categories[c.name] = c.total;

  return {
    week: { income: weekS.income, expense: weekS.expense },
    month: { income: monthS.income, expense: monthS.expense },
    ytd: { income: ytdS.income, expense: ytdS.expense },
    categories,
    balances,
  };
}
