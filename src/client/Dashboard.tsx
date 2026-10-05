import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import type { ActivityFilter } from './store';
import { api } from './api';
import { money, categoryDisplayName, groupCategoryTotals } from './lib';
import type { CategoryGroup } from './lib';
import { Empty, Err } from './ui';
import { TxRow } from './TxRow';
import { periodStart, PERIOD_PRESETS } from '../shared/period';
import type { CategoryTotal, Dashboard as DashboardData } from '../shared/types';

type FrameData = {
  label: string;
  from: string;
  to: string | null;
  income: number;
  expense: number;
  refunded: number;
};

type CustomWidget = { key: string; label: string; from: string; to: string | null };

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
  activeBreakdowns: 'method'[];
};
function loadPersisted(): PersistedLayout | null {
  try {
    const raw = sessionStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const layout = JSON.parse(raw) as PersistedLayout;
    // Older sessions may still list the removed "By payee" breakdown.
    layout.activeBreakdowns = (layout.activeBreakdowns ?? []).filter((d) => d === 'method');
    return layout;
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
 * "By category" / "By payment method" card: its own timeframe
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
  hideBalance,
  group,
  dashboard,
}: {
  title: string;
  emptyNoun: string;
  accountFilter: string;
  accountLabel?: string;
  fetcher: (
    from: string,
    to: string | null,
    accountId: string | undefined,
    type: 'expense' | 'income',
    signal?: AbortSignal
  ) => Promise<CategoryTotal[]>;
  buildFilter: (
    item: CategoryTotal,
    from: string,
    to: string | null,
    type: 'expense' | 'income',
    opts?: { includeSubcategories?: boolean }
  ) => ActivityFilter;
  onRemove?: () => void;
  /** Hide the Balance toggle (e.g. categories, where income − expense is meaningless). */
  hideBalance?: boolean;
  /** Group flat rows into expandable parent/child rows (category card). */
  group?: (rows: CategoryTotal[]) => CategoryGroup[];
  dashboard: DashboardData | null;
}) {
  const { openActivity } = useStore();
  const [key, setKey] = useState<string>('month');
  const [type, setType] = useState<BreakdownType>('expense');
  const [data, setData] = useState<CategoryTotal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => (group ? group(data) : null), [group, data]);
  const toggleExpanded = (k: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  const isCustom = key === 'custom';
  const from = useMemo(() => {
    if (isCustom) return customFrom ? dateInputToIso(customFrom) : periodStart('month');
    const preset = PERIOD_PRESETS.find((p) => p.key === key);
    return preset ? preset.from(Date.now()) : periodStart('month');
  }, [key, customFrom]); // eslint-disable-line react-hooks/exhaustive-deps
  const to = isCustom && customFrom ? dateInputToExclusiveEndIso(customTo) : null;

  useEffect(() => {
    if (!dashboard || (isCustom && !customFrom)) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    (async () => {
      try {
        const rows =
          group && key === 'month' && type === 'expense' && !accountFilter
            ? dashboard.categories
            : type === 'balance'
              ? await mergeBalance(fetcher, from, to, accountFilter || undefined, controller.signal)
              : await fetcher(from, to, accountFilter || undefined, type, controller.signal);
        if (!controller.signal.aborted) setData(rows);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load breakdown');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, type, accountFilter, dashboard, attempt]);

  const max = Math.max(
    ...(groups
      ? groups.flatMap((g) => [g, ...g.children]).map((d) => Math.abs(d.total))
      : data.map((d) => Math.abs(d.total))),
    1
  );
  const drillType: 'expense' | 'income' = type === 'income' ? 'income' : 'expense';
  const renderBar = (
    c: CategoryTotal,
    rowKey: string,
    opts: { includeSubcategories?: boolean; child?: boolean; toggleKey?: string } = {}
  ) => (
    <div
      className={'bar' + (opts.child ? ' barchild' : '')}
      key={rowKey}
      onClick={() =>
        openActivity(
          buildFilter(c, from, to, drillType, { includeSubcategories: opts.includeSubcategories })
        )
      }
    >
      <span className="barlabel">
        {opts.toggleKey !== undefined ? (
          <button
            type="button"
            className="bartoggle"
            aria-expanded={expanded.has(opts.toggleKey)}
            title={expanded.has(opts.toggleKey) ? 'Hide subcategories' : 'Show subcategories'}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(opts.toggleKey!);
            }}
          >
            {expanded.has(opts.toggleKey) ? '▾' : '▸'}
          </button>
        ) : groups && !opts.child ? (
          <span className="bartoggle placeholder" aria-hidden="true" />
        ) : null}
        <span className="barname">{c.name}</span>
      </span>
      <i
        className={c.total < 0 ? 'neg' : ''}
        style={{ width: `${Math.max(7, (Math.abs(c.total) / max) * 100)}%` }}
      ></i>
      <b className={type === 'balance' ? (c.total >= 0 ? 'positive' : 'negative') : ''}>
        {money(c.total)}
      </b>
    </div>
  );
  const label = isCustom
    ? customFrom
      ? `${customFrom} → ${customTo}`
      : 'Pick a custom range'
    : PERIOD_PRESETS.find((p) => p.key === key)?.label || 'This month';

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
            {!hideBalance && (
              <button
                className={type === 'balance' ? 'selected' : ''}
                onClick={() => setType('balance')}
              >
                Balance
              </button>
            )}
          </div>
          {onRemove && (
            <button className="framehead-remove" onClick={onRemove} title="Remove widget">
              ×
            </button>
          )}
        </div>
      </div>
      <div className="cattabs">
        {PERIOD_PRESETS.map((p) => (
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
      {loading ? (
        <div className="loading" role="status">
          Loading…
        </div>
      ) : error ? (
        <div>
          <Err msg={error} />
          <button className="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : data.length ? (
        <div className="bars">
          {groups
            ? groups.flatMap((g) => {
                const gKey = g.id ?? 'none';
                const hasKids = g.children.length > 0;
                const open = hasKids && expanded.has(gKey);
                return [
                  renderBar(g, `g:${gKey}`, {
                    includeSubcategories: g.includeSubcategories,
                    toggleKey: hasKids ? gKey : undefined,
                  }),
                  ...(open
                    ? g.children.map((ch) =>
                        renderBar(ch, `c:${gKey}:${ch.id ?? 'none'}:${ch.name}`, { child: true })
                      )
                    : []),
                ];
              })
            : data.map((c) => renderBar(c, c.id ?? 'none'))}
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
    type: 'expense' | 'income',
    signal?: AbortSignal
  ) => Promise<CategoryTotal[]>,
  from: string,
  to: string | null,
  accountId: string | undefined,
  signal?: AbortSignal
): Promise<CategoryTotal[]> {
  const [expenseRows, incomeRows] = await Promise.all([
    fetcher(from, to, accountId, 'expense', signal),
    fetcher(from, to, accountId, 'income', signal),
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
  const { accounts, categories, transactions, go, open, openActivity } = useStore();
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDash(null);
    setLoadError('');
    api
      .dashboard(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setDash(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setLoadError(e instanceof Error ? e.message : 'Unable to load dashboard');
      });
    return () => controller.abort();
  }, [transactions, attempt]);
  const persisted = useMemo(() => loadPersisted(), []);
  const groupByCategory = useMemo(
    () => (rows: CategoryTotal[]) => groupCategoryTotals(rows, categories),
    [categories]
  );

  // ---- account scope: everything below reacts to this ----
  const [accountFilter, setAccountFilter] = useState(persisted?.accountFilter ?? '');

  // ---- timeframe widgets ----
  const [activeKeys, setActiveKeys] = useState<string[]>(
    persisted?.activeKeys ?? ['week', 'month']
  );
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>(
    persisted?.customWidgets ?? []
  );
  const [frames, setFrames] = useState<Record<string, FrameData>>({});
  const [framesLoading, setFramesLoading] = useState(true);
  const [frameError, setFrameError] = useState('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  // ---- on-demand breakdown widgets (category is always shown separately) ----
  const [activeBreakdowns, setActiveBreakdowns] = useState<'method'[]>(
    persisted?.activeBreakdowns ?? []
  );

  // Persist the widget layout for the rest of this browser tab session.
  useEffect(() => {
    savePersisted({ accountFilter, activeKeys, customWidgets, activeBreakdowns });
  }, [accountFilter, activeKeys, customWidgets, activeBreakdowns]);

  // Reuse the current response for default frames; fetch independent extras in parallel.
  useEffect(() => {
    if (!dash) return;
    const controller = new AbortController();
    setFramesLoading(true);
    setFrameError('');
    (async () => {
      try {
        const entries = await Promise.all(
          activeKeys.map(async (key): Promise<[string, FrameData] | null> => {
            const seeded = !accountFilter && dash.frames.find((f) => f.key === key);
            if (seeded) return [key, seeded];
            const preset = PERIOD_PRESETS.find((p) => p.key === key);
            const cw = !preset ? customWidgets.find((c) => c.key === key) : null;
            if (!preset && !cw) return null;
            const from = preset ? preset.from(Date.now()) : cw!.from;
            const to = preset ? null : cw!.to;
            const label = preset ? preset.label : cw!.label;
            const stats = await api.dashboardFrame(
              from,
              to,
              accountFilter || undefined,
              controller.signal
            );
            return [key, { label, from, to, ...stats }];
          })
        );
        if (!controller.signal.aborted)
          setFrames(Object.fromEntries(entries.filter((entry) => entry !== null)));
      } catch (e) {
        if (!controller.signal.aborted)
          setFrameError(e instanceof Error ? e.message : 'Unable to load totals');
      } finally {
        if (!controller.signal.aborted) setFramesLoading(false);
      }
    })();
    return () => controller.abort();
  }, [accountFilter, activeKeys, customWidgets, dash]);

  const selectAccount = (value: string) => {
    setFramesLoading(true);
    setAccountFilter(value);
  };

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

  const availablePresets = PERIOD_PRESETS.filter((p) => !activeKeys.includes(p.key));

  const accountLabel = accountFilter
    ? accounts.find((a) => a.id === accountFilter)?.name
    : 'All accounts';

  const BREAKDOWN_DEFS: Record<'method', { title: string; emptyNoun: string }> = {
    method: { title: 'By payment method', emptyNoun: 'payment method' },
  };

  if (loadError)
    return (
      <main>
        <Err msg={loadError} />
        <button className="outline" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
      </main>
    );
  if (!dash)
    return (
      <main>
        <div className="loading" role="status">
          Loading dashboard…
        </div>
      </main>
    );

  return (
    <main>
      <div className="accountscope">
        <span>Viewing</span>
        <select value={accountFilter} onChange={(e) => selectAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="framegrid">
        {framesLoading && (
          <div className="loading" role="status">
            Loading totals…
          </div>
        )}
        {frameError && (
          <div>
            <Err msg={frameError} />
            <button className="outline" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        )}
        {activeKeys.map((key) => {
          const f = !framesLoading && !frameError ? frames[key] : null;
          if (!f) return null;
          // Refunds are netted directly against expense (see rangeStats in
          // aggregate.ts), so no separate add-back is needed here.
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
        dashboard={dash}
        title="By category"
        emptyNoun="category"
        accountFilter={accountFilter}
        accountLabel={accountLabel}
        fetcher={api.dashboardCategories}
        hideBalance
        group={groupByCategory}
        buildFilter={(c, from, to, type, opts) => {
          const isSub = !!categories.find((x) => x.id === c.id)?.parent_id;
          // Subcategory rows show their bare name (they sit indented under
          // the parent), so give Activity the unambiguous "Parent › Child".
          const name = isSub ? categoryDisplayName(categories, c.id, c.name) : c.name;
          return {
            categoryId: c.id,
            includeSubcategories: opts?.includeSubcategories || undefined,
            type,
            accountId: accountFilter || undefined,
            from,
            to,
            label: `${name} · ${type}`,
          };
        }}
      />

      {activeBreakdowns.map((dim) => (
        <BreakdownCard
          dashboard={dash}
          key={dim}
          title={BREAKDOWN_DEFS[dim].title}
          emptyNoun={BREAKDOWN_DEFS[dim].emptyNoun}
          accountFilter={accountFilter}
          accountLabel={accountLabel}
          fetcher={(from, to, acct, type, signal) =>
            api.dashboardBreakdown(dim, from, to, acct, type, signal)
          }
          buildFilter={(c, from, to, type) => ({
            methodId: c.id || undefined,
            type,
            accountId: accountFilter || undefined,
            from,
            to,
            label: `${c.name} · ${type}`,
          })}
          onRemove={() => setActiveBreakdowns((cur) => cur.filter((d) => d !== dim))}
        />
      ))}

      {(['method'] as const).filter((d) => !activeBreakdowns.includes(d)).length > 0 && (
        <div className="addwidget">
          <span>Add breakdown:</span>
          {(['method'] as const)
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
            categories={categories}
            onClick={() => open({ kind: 'detail', id: t.id })}
            onOpenRef={(refId) => open({ kind: 'detail', id: refId })}
          />
        ))}
        {!transactions.length && <Empty text="No transactions yet." />}
      </section>
    </main>
  );
}
