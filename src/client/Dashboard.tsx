import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import type { ActivityFilter } from './store';
import { api } from './api';
import { money } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';
import { periodStart, daysAgo } from '../shared/period';
import type { CategoryTotal } from '../shared/types';

type FrameData = {
  label: string;
  from: string;
  to: string | null;
  income: number;
  expense: number;
};

type CustomWidget = { key: string; label: string; from: string; to: string | null };

const ALL_PRESETS: { key: string; label: string; from: (now: number) => string }[] = [
  { key: 'today', label: 'Today', from: (n) => periodStart('day', n) },
  { key: 'week', label: 'This week', from: (n) => periodStart('week', n) },
  { key: 'month', label: 'This month', from: (n) => periodStart('month', n) },
  { key: 'ytd', label: 'This year (YTD)', from: (n) => periodStart('year', n) },
  { key: 'last30', label: 'Last 30 days', from: (n) => daysAgo(30, n) },
  { key: 'last12m', label: 'Last 12 months', from: (n) => daysAgo(365, n) },
];

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * "By category" / "By payment method" / "By payee" card: its own timeframe
 * tabs + Expense/Income toggle, scoped to whatever account is selected above,
 * with each bar clickable through to Activity pre-filtered accordingly.
 */
function BreakdownCard({
  title,
  emptyNoun,
  accountFilter,
  accountLabel,
  fetcher,
  buildFilter,
}: {
  title: string;
  emptyNoun: string;
  accountFilter: string;
  accountLabel?: string;
  fetcher: (
    from: string,
    to: string | null,
    accountId: string | undefined,
    type: 'expense' | 'income'
  ) => Promise<CategoryTotal[]>;
  buildFilter: (item: CategoryTotal, from: string, type: 'expense' | 'income') => ActivityFilter;
}) {
  const { openActivity } = useStore();
  const [key, setKey] = useState<string>('month');
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [data, setData] = useState<CategoryTotal[]>([]);

  const from = useMemo(() => {
    const preset = ALL_PRESETS.find((p) => p.key === key);
    return preset ? preset.from(Date.now()) : periodStart('month');
  }, [key]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetcher(from, null, accountFilter || undefined, type).catch(() => []);
      if (!cancelled) setData(rows);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, type, accountFilter]);

  const max = data[0]?.total || 1;
  const label = ALL_PRESETS.find((p) => p.key === key)?.label || 'This month';

  return (
    <section className="card">
      <div className="cardhead">
        <div>
          <h2>{title}</h2>
          <p>
            {accountFilter ? `${accountLabel} · ` : ''}
            {label}
          </p>
        </div>
        <div className="segmented small">
          <button
            className={type === 'expense' ? 'selected' : ''}
            onClick={() => setType('expense')}
          >
            Expense
          </button>
          <button className={type === 'income' ? 'selected' : ''} onClick={() => setType('income')}>
            Income
          </button>
        </div>
      </div>
      <div className="cattabs">
        {ALL_PRESETS.map((p) => (
          <button
            key={p.key}
            className={key === p.key ? 'selected' : ''}
            onClick={() => setKey(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {data.length ? (
        <div className="bars">
          {data.map((c) => (
            <div
              className="bar"
              key={c.id ?? 'none'}
              onClick={() => openActivity(buildFilter(c, from, type))}
            >
              <span>{c.name}</span>
              <i style={{ width: `${Math.max(7, (c.total / max) * 100)}%` }}></i>
              <b>{money(c.total)}</b>
            </div>
          ))}
        </div>
      ) : (
        <Empty text={`No ${type} recorded for any ${emptyNoun} in this period.`} />
      )}
    </section>
  );
}

export function Dashboard() {
  const { dash, accounts, transactions, go, open, openActivity } = useStore();

  // ---- account scope: everything below reacts to this ----
  const [accountFilter, setAccountFilter] = useState('');

  // ---- timeframe widgets ----
  const [activeKeys, setActiveKeys] = useState<string[]>(['week', 'month']);
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>([]);
  const [frameCache, setFrameCache] = useState<Record<string, FrameData>>({});
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  // Seed from the bootstrap dashboard payload (all-accounts) so the default
  // widgets aren't empty for an instant before the scoped fetch resolves.
  useEffect(() => {
    if (accountFilter) return;
    const seed: Record<string, FrameData> = {};
    for (const f of dash?.frames || []) seed[f.key] = f;
    setFrameCache((cur) => ({ ...seed, ...cur }));
  }, [dash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch every active widget whenever the account scope, the active set,
  // or a custom range changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const key of activeKeys) {
        const preset = ALL_PRESETS.find((p) => p.key === key);
        const cw = !preset ? customWidgets.find((c) => c.key === key) : null;
        if (!preset && !cw) continue;
        const from = preset ? preset.from(Date.now()) : cw!.from;
        const to = preset ? null : cw!.to;
        const label = preset ? preset.label : cw!.label;
        const stats = await api
          .dashboardFrame(from, to, accountFilter || undefined)
          .catch(() => null);
        if (cancelled) return;
        if (stats) setFrameCache((cur) => ({ ...cur, [key]: { label, from, to, ...stats } }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountFilter, activeKeys, customWidgets]);

  const addWidget = (key: string) => {
    if (!activeKeys.includes(key)) setActiveKeys((cur) => [...cur, key]);
  };
  const removeWidget = (key: string) => {
    setActiveKeys((cur) => cur.filter((k) => k !== key));
    setCustomWidgets((cur) => cur.filter((c) => c.key !== key));
  };
  const addCustomWidget = () => {
    if (!customFrom) return;
    const from = new Date(customFrom + 'T00:00:00').toISOString();
    const toExclusive = new Date(customTo + 'T00:00:00');
    toExclusive.setDate(toExclusive.getDate() + 1);
    const to = toExclusive.toISOString();
    const key = `custom-${customFrom}-${customTo}`;
    const label = `${customFrom} → ${customTo}`;
    setCustomWidgets((cur) =>
      cur.some((c) => c.key === key) ? cur : [...cur, { key, label, from, to }]
    );
    setActiveKeys((cur) => (cur.includes(key) ? cur : [...cur, key]));
    setShowCustom(false);
  };

  const availablePresets = ALL_PRESETS.filter((p) => !activeKeys.includes(p.key));

  const accountLabel = accountFilter
    ? accounts.find((a) => a.id === accountFilter)?.name
    : 'All accounts';

  return (
    <main>
      <div className="accountscope">
        <span>Viewing</span>
        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="framegrid">
        {activeKeys.map((key) => {
          const f = frameCache[key];
          if (!f) return null;
          const net = f.income - f.expense;
          return (
            <div className="framebox" key={key}>
              <div className="framehead">
                <b>{f.label}</b>
                <button onClick={() => removeWidget(key)} title="Remove widget">
                  ×
                </button>
              </div>
              <button
                className="framerow"
                onClick={() =>
                  openActivity({
                    type: 'income',
                    accountId: accountFilter || undefined,
                    from: f.from,
                    to: f.to,
                    label: `${f.label} · income${accountFilter ? ` · ${accountLabel}` : ''}`,
                  })
                }
              >
                <span>Income</span>
                <span className="amt-income">{money(f.income)}</span>
              </button>
              <button
                className="framerow"
                onClick={() =>
                  openActivity({
                    type: 'expense',
                    accountId: accountFilter || undefined,
                    from: f.from,
                    to: f.to,
                    label: `${f.label} · expense${accountFilter ? ` · ${accountLabel}` : ''}`,
                  })
                }
              >
                <span>Expense</span>
                <span className="amt-expense">{money(f.expense)}</span>
              </button>
              <button
                className="framerow balance"
                onClick={() =>
                  openActivity({
                    accountId: accountFilter || undefined,
                    from: f.from,
                    to: f.to,
                    label: f.label,
                  })
                }
              >
                <span>Balance</span>
                <span className={net >= 0 ? 'positive' : ''}>{money(net)}</span>
              </button>
            </div>
          );
        })}
      </div>

      {(availablePresets.length > 0 || showCustom) && (
        <div className="addwidget">
          <span>Add widget:</span>
          {availablePresets.map((p) => (
            <button key={p.key} onClick={() => addWidget(p.key)}>
              ＋ {p.label}
            </button>
          ))}
          <button onClick={() => setShowCustom((v) => !v)}>＋ Custom range</button>
        </div>
      )}
      {showCustom && (
        <div className="customrange">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          <span>to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
          <button className="primary" onClick={addCustomWidget} disabled={!customFrom}>
            Add
          </button>
        </div>
      )}

      {dash?.balances?.length ? (
        <section className="card">
          <div className="cardhead">
            <h2>Account balances</h2>
          </div>
          <div className="balances">
            {dash.balances.map((a) => {
              const bal = a.balance_minor ?? a.opening_balance_minor;
              return (
                <button
                  className="balance"
                  key={a.id}
                  onClick={() => openActivity({ accountId: a.id, label: a.name })}
                >
                  <span>{a.name}</span>
                  <b className={bal < 0 ? '' : 'positive'}>{money(bal)}</b>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <BreakdownCard
        title="By category"
        emptyNoun="category"
        accountFilter={accountFilter}
        accountLabel={accountLabel}
        fetcher={(from, to, acct, type) => api.dashboardCategories(from, to, acct, type)}
        buildFilter={(c, from, type) => ({
          categoryId: c.id,
          type,
          accountId: accountFilter || undefined,
          from,
          label: `${c.name} · ${type}`,
        })}
      />

      <BreakdownCard
        title="By payment method"
        emptyNoun="payment method"
        accountFilter={accountFilter}
        accountLabel={accountLabel}
        fetcher={(from, to, acct, type) => api.dashboardBreakdown('method', from, to, acct, type)}
        buildFilter={(c, from, type) => ({
          methodId: c.id || undefined,
          type,
          accountId: accountFilter || undefined,
          from,
          label: `${c.name} · ${type}`,
        })}
      />

      <BreakdownCard
        title="By payee"
        emptyNoun="payee"
        accountFilter={accountFilter}
        accountLabel={accountLabel}
        fetcher={(from, to, acct, type) => api.dashboardBreakdown('payee', from, to, acct, type)}
        buildFilter={(c, from, type) => ({
          payeeId: c.id || undefined,
          type,
          accountId: accountFilter || undefined,
          from,
          label: `${c.name} · ${type}`,
        })}
      />

      <section className="card">
        <div className="cardhead">
          <h2>Recent activity</h2>
          <button className="link" onClick={() => go('activity')}>
            View all →
          </button>
        </div>
        {transactions.slice(0, 7).map((t) => (
          <TxRow
            key={t.id}
            t={t}
            onClick={() => open({ kind: 'detail', id: t.id })}
            onOpenRef={(refId) => open({ kind: 'detail', id: refId })}
          />
        ))}
        {!transactions.length && <Empty text="No transactions yet." />}
      </section>
    </main>
  );
}
