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
  refunded: number;
};

type CustomWidget = { key: string; label: string; from: string; to: string | null };

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

const ALL_PRESETS: { key: string; label: string; from: (now: number) => string }[] = [
  { key: 'today', label: 'Today', from: (n) => periodStart('day', n) },
  { key: 'week', label: 'This week', from: (n) => periodStart('week', n) },
  { key: 'month', label: 'This month', from: (n) => periodStart('month', n) },
  { key: 'ytd', label: 'This year (YTD)', from: (n) => periodStart('year', n) },
  { key: 'last30', label: 'Last 30 days', from: (n) => daysAgo(30, n) },
  { key: 'last12m', label: 'Last 12 months', from: (n) => daysAgo(365, n) },
  { key: 'all', label: 'All time', from: () => EPOCH_ISO },
];

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- persist widget layout for the current browser tab session only ----
// (sessionStorage, not localStorage: "remain till the session is active",
// cleared automatically once the tab is closed.)
const PERSIST_KEY = 'em_dashboard_layout_v1';
type PersistedLayout = {
  accountFilter: string;
  activeKeys: string[];
  customWidgets: CustomWidget[];
  activeBreakdowns: ('method' | 'payee')[];
};
function loadPersisted(): PersistedLayout | null {
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY);
    return raw ? (JSON.parse(raw) as PersistedLayout) : null;
  } catch {
    return null;
  }
}
function savePersisted(layout: PersistedLayout) {
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(layout));
  } catch {
    // ignore (private browsing, storage disabled, etc.)
  }
}

/** yyyy-mm-dd (local) -> UTC ISO instant at local midnight. */
function dateInputToIso(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00').toISOString();
}
/** Exclusive upper bound: the ISO instant for the start of the day *after* dateStr. */
function dateInputToExclusiveEndIso(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

type BreakdownType = 'expense' | 'income' | 'balance';

/**
 * "By category" / "By payment method" / "By payee" card: its own timeframe
 * tabs (with a custom date range option) + Expense/Income/Balance toggle,
 * scoped to whatever account is selected above, with each bar clickable
 * through to Activity pre-filtered accordingly.
 */
function BreakdownCard({
  title,
  emptyNoun,
  accountFilter,
  accountLabel,
  fetcher,
  buildFilter,
  onRemove,
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
  buildFilter: (
    item: CategoryTotal,
    from: string,
    to: string | null,
    type: 'expense' | 'income'
  ) => ActivityFilter;
  onRemove?: () => void;
}) {
  const { openActivity } = useStore();
  const [key, setKey] = useState<string>('month');
  const [type, setType] = useState<BreakdownType>('expense');
  const [data, setData] = useState<CategoryTotal[]>([]);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  const isCustom = key === 'custom';
  const from = useMemo(() => {
    if (isCustom) return customFrom ? dateInputToIso(customFrom) : periodStart('month');
    const preset = ALL_PRESETS.find((p) => p.key === key);
    return preset ? preset.from(Date.now()) : periodStart('month');
  }, [key, customFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = isCustom && customFrom ? dateInputToExclusiveEndIso(customTo) : null;

  useEffect(() => {
    if (isCustom && !customFrom) return; // custom picked but no date chosen yet
    let cancelled = false;
    (async () => {
      const rows =
        type === 'balance'
          ? await mergeBalance(fetcher, from, to, accountFilter || undefined)
          : await fetcher(from, to, accountFilter || undefined, type).catch(() => []);
      if (!cancelled) setData(rows);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, type, accountFilter]);

  const max = Math.max(...data.map((d) => Math.abs(d.total)), 1);
  const label = isCustom
    ? customFrom
      ? `${customFrom} → ${customTo}`
      : 'Pick a custom range'
    : ALL_PRESETS.find((p) => p.key === key)?.label || 'This month';

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
        <div className="cardheadright">
          <div className="segmented small">
            <button
              className={type === 'expense' ? 'selected' : ''}
              onClick={() => setType('expense')}
            >
              Expense
            </button>
            <button
              className={type === 'income' ? 'selected' : ''}
              onClick={() => setType('income')}
            >
              Income
            </button>
            <button
              className={type === 'balance' ? 'selected' : ''}
              onClick={() => setType('balance')}
            >
              Balance
            </button>
          </div>
          {onRemove && (
            <button className="framehead-remove" onClick={onRemove} title="Remove widget">
              ×
            </button>
          )}
        </div>
      </div>
      <div className="cattabs">
        {ALL_PRESETS.map((p) => (
          <button
            key={p.key}
            className={key === p.key ? 'selected' : ''}
            onClick={() => {
              setKey(p.key);
              setShowCustom(false);
            }}
          >
            {p.label}
          </button>
        ))}
        <button
          className={isCustom ? 'selected' : ''}
          onClick={() => {
            setKey('custom');
            setShowCustom(true);
          }}
        >
          Custom
        </button>
      </div>
      {showCustom && isCustom && (
        <div className="customrange">
          <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
          <span>to</span>
          <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
        </div>
      )}
      {data.length ? (
        <div className="bars">
          {data.map((c) => (
            <div
              className="bar"
              key={c.id ?? 'none'}
              onClick={() =>
                openActivity(buildFilter(c, from, to, type === 'income' ? 'income' : 'expense'))
              }
            >
              <span>{c.name}</span>
              <i
                className={c.total < 0 ? 'neg' : ''}
                style={{ width: `${Math.max(7, (Math.abs(c.total) / max) * 100)}%` }}
              ></i>
              <b className={type === 'balance' ? (c.total >= 0 ? 'positive' : 'negative') : ''}>
                {money(c.total)}
              </b>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          text={`No ${type === 'balance' ? 'activity' : type} recorded for any ${emptyNoun} in this period.`}
        />
      )}
    </section>
  );
}

/** Fetch expense + income breakdowns and merge into a net (income - expense) per bucket. */
async function mergeBalance(
  fetcher: (
    from: string,
    to: string | null,
    accountId: string | undefined,
    type: 'expense' | 'income'
  ) => Promise<CategoryTotal[]>,
  from: string,
  to: string | null,
  accountId: string | undefined
): Promise<CategoryTotal[]> {
  const [expenseRows, incomeRows] = await Promise.all([
    fetcher(from, to, accountId, 'expense').catch(() => []),
    fetcher(from, to, accountId, 'income').catch(() => []),
  ]);
  const map = new Map<string, CategoryTotal>();
  const keyOf = (r: CategoryTotal) => r.id ?? `name:${r.name}`;
  for (const r of expenseRows) {
    const k = keyOf(r);
    const cur = map.get(k) || { id: r.id, name: r.name, total: 0 };
    cur.total -= r.total;
    map.set(k, cur);
  }
  for (const r of incomeRows) {
    const k = keyOf(r);
    const cur = map.get(k) || { id: r.id, name: r.name, total: 0 };
    cur.total += r.total;
    map.set(k, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

export function Dashboard() {
  const { dash, accounts, transactions, go, open, openActivity } = useStore();
  const persisted = useMemo(() => loadPersisted(), []);

  // ---- account scope: everything below reacts to this ----
  const [accountFilter, setAccountFilter] = useState(persisted?.accountFilter ?? '');

  // ---- timeframe widgets ----
  const [activeKeys, setActiveKeys] = useState<string[]>(
    persisted?.activeKeys ?? ['week', 'month']
  );
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>(
    persisted?.customWidgets ?? []
  );
  const [frameCache, setFrameCache] = useState<Record<string, FrameData>>({});
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  // ---- on-demand breakdown widgets (category is always shown separately) ----
  const [activeBreakdowns, setActiveBreakdowns] = useState<('method' | 'payee')[]>(
    persisted?.activeBreakdowns ?? []
  );

  // Persist the widget layout for the rest of this browser tab session.
  useEffect(() => {
    savePersisted({ accountFilter, activeKeys, customWidgets, activeBreakdowns });
  }, [accountFilter, activeKeys, customWidgets, activeBreakdowns]);

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

  const BREAKDOWN_DEFS: Record<'method' | 'payee', { title: string; emptyNoun: string }> = {
    method: { title: 'By payment method', emptyNoun: 'payment method' },
    payee: { title: 'By payee', emptyNoun: 'payee' },
  };

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
          // Refund income is tracked separately from regular income (see
          // rangeStats in aggregate.ts) but is still real money back in the
          // account, so it must be added back in for the net to match the
          // Activity page's running balance for the same period.
          const net = f.income - f.expense + f.refunded;
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
        buildFilter={(c, from, to, type) => ({
          categoryId: c.id,
          type,
          accountId: accountFilter || undefined,
          from,
          to,
          label: `${c.name} · ${type}`,
        })}
      />

      {activeBreakdowns.map((dim) => (
        <BreakdownCard
          key={dim}
          title={BREAKDOWN_DEFS[dim].title}
          emptyNoun={BREAKDOWN_DEFS[dim].emptyNoun}
          accountFilter={accountFilter}
          accountLabel={accountLabel}
          fetcher={(from, to, acct, type) => api.dashboardBreakdown(dim, from, to, acct, type)}
          buildFilter={(c, from, to, type) => ({
            ...(dim === 'method'
              ? { methodId: c.id || undefined }
              : { payeeId: c.id || undefined }),
            type,
            accountId: accountFilter || undefined,
            from,
            to,
            label: `${c.name} · ${type}`,
          })}
          onRemove={() => setActiveBreakdowns((cur) => cur.filter((d) => d !== dim))}
        />
      ))}

      {(['method', 'payee'] as const).filter((d) => !activeBreakdowns.includes(d)).length > 0 && (
        <div className="addwidget">
          <span>Add breakdown:</span>
          {(['method', 'payee'] as const)
            .filter((d) => !activeBreakdowns.includes(d))
            .map((d) => (
              <button key={d} onClick={() => setActiveBreakdowns((cur) => [...cur, d])}>
                ＋ {BREAKDOWN_DEFS[d].title}
              </button>
            ))}
        </div>
      )}

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
