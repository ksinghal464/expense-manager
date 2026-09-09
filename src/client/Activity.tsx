import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import type { SearchOptions } from './api';
import { useDebounce, categoryRoots, categoryChildren } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';
import {
  istDateTimeToUTC,
  toISTDate,
  periodStart,
  previousPeriodStart,
  daysAgo,
} from '../shared/period';

function toDateInput(iso: string): string {
  return iso ? toISTDate(iso) : '';
}
function fromDateInput(dateStr: string): string {
  return dateStr ? istDateTimeToUTC(dateStr) : '';
}
/** Exclusive upper bound: the ISO instant for the start of the day *after* dateStr. */
function endOfDayIso(dateStr: string): string {
  const d = new Date(istDateTimeToUTC(dateStr));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

const DATE_PRESETS: { key: string; label: string; from: () => string; to: () => string | null }[] =
  [
    { key: 'week', label: 'This week', from: () => periodStart('week'), to: () => null },
    {
      key: 'lastweek',
      label: 'Last week',
      from: () => previousPeriodStart('week'),
      to: () => periodStart('week'),
    },
    { key: 'month', label: 'This month', from: () => periodStart('month'), to: () => null },
    {
      key: 'lastmonth',
      label: 'Last month',
      from: () => previousPeriodStart('month'),
      to: () => periodStart('month'),
    },
    { key: 'last30', label: 'Last 30 days', from: () => daysAgo(30), to: () => null },
    { key: 'ytd', label: 'YTD', from: () => periodStart('year'), to: () => null },
    { key: 'all', label: 'All time', from: () => '1970-01-01T00:00:00.000Z', to: () => null },
  ];

export function Activity() {
  const {
    transactions,
    accounts,
    methods,
    categories,
    payees,
    tags,
    open,
    pendingActivityFilter,
    clearActivityFilter,
  } = useStore();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | 'expense' | 'income'>('all');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string | null | undefined>(undefined);
  const [methodId, setMethodId] = useState('');
  const [payeeId, setPayeeId] = useState('');
  const [status, setStatus] = useState<'' | 'cleared' | 'uncleared'>('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [filterLabel, setFilterLabel] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const debounced = useDebounce(query, 180);
  const lastTerm = useMemo(() => debounced.trim().split(/\s+/).pop() || '', [debounced]);
  const [options, setOptions] = useState<SearchOptions | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);

  // Apply a filter handed off from the Dashboard (e.g. "this week's expenses",
  // an account balance, or a category bar), then clear it so it doesn't stick
  // around on the next manual visit to Activity.
  useEffect(() => {
    if (!pendingActivityFilter) return;
    const f = pendingActivityFilter;
    setType(f.type || 'all');
    setAccountId(f.accountId || '');
    setCategoryId(f.categoryId);
    setMethodId(f.methodId || '');
    setPayeeId(f.payeeId || '');
    setStatus(f.status || '');
    setTag(f.tag || '');
    setFrom(f.from || '');
    setTo(f.to ?? null);
    setFilterLabel(f.label || '');
    setShowFilters(false);
    clearActivityFilter();
  }, [pendingActivityFilter, clearActivityFilter]);

  // server-side search suggestions while typing (based on just the word
  // currently being composed, so accumulating multiple terms still gets
  // relevant suggestions for the latest one instead of matching the whole
  // multi-word string against the backend).
  useEffect(() => {
    if (!lastTerm) {
      setOptions(null);
      return;
    }
    api
      .searchOptions(lastTerm)
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [lastTerm]);

  const clearAllFilters = () => {
    setType('all');
    setAccountId('');
    setCategoryId(undefined);
    setMethodId('');
    setPayeeId('');
    setStatus('');
    setTag('');
    setFrom('');
    setTo(null);
    setFilterLabel('');
  };

  const accountMethods = useMemo(
    () => (accountId ? methods.filter((m) => m.account_id === accountId) : methods),
    [methods, accountId]
  );
  const roots = categoryRoots(categories);

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = transactions;
    if (type !== 'all') list = list.filter((t) => t.transaction_type === type);
    if (accountId) list = list.filter((t) => t.account_id === accountId);
    if (categoryId !== undefined) list = list.filter((t) => (t.category_id || null) === categoryId);
    if (methodId) list = list.filter((t) => t.payment_method_id === methodId);
    if (payeeId) list = list.filter((t) => t.payee_id === payeeId);
    if (status) list = list.filter((t) => t.status === status);
    if (tag) list = list.filter((t) => (t.tags || []).includes(tag));
    if (from) list = list.filter((t) => t.occurred_at >= from);
    if (to) list = list.filter((t) => t.occurred_at < to);
    if (!terms.length) return list;
    // Every space-separated term must appear somewhere (AND, not one
    // contiguous phrase) so clicking multiple suggestions — e.g. a category
    // then a payment method — narrows down instead of requiring an exact
    // combined phrase match.
    return list.filter((t) => {
      const haystack = [
        t.description,
        t.note,
        t.category_name,
        t.account_name,
        t.payment_method_name,
        t.payee_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [transactions, query, type, accountId, categoryId, methodId, payeeId, status, tag, from, to]);

  // Whether any filter narrows the list down from "every transaction,
  // across every account" — including just picking one account in the
  // top-level scope selector, since that's still a narrower view than the
  // true (opening-balance-based) running balance represents.
  const hasSubsetFilter = Boolean(
    query.trim() ||
    type !== 'all' ||
    accountId ||
    categoryId !== undefined ||
    methodId ||
    payeeId ||
    status ||
    tag ||
    from ||
    to
  );

  // Running balance shown per row. With no filter active at all, this is
  // each account's real running balance (opening balance + cumulative net of
  // every transaction, in chronological order, grouped by account so one
  // account's balance never bleeds into another's). As soon as any filter —
  // including just scoping to one account — narrows the list, the balance
  // instead reflects the net change over just what's currently visible
  // (starting from zero): the real opening-balance-based total isn't
  // meaningful once the list no longer represents "everything".
  const balanceById = useMemo(() => {
    const source = hasSubsetFilter ? filtered : transactions;
    const openingByAccount = new Map(accounts.map((a) => [a.id, a.opening_balance_minor]));
    const byAccount = new Map<string, typeof transactions>();
    for (const t of source) {
      const arr = byAccount.get(t.account_id) || [];
      arr.push(t);
      byAccount.set(t.account_id, arr);
    }
    const map: Record<string, number> = {};
    for (const [accId, txs] of byAccount) {
      const asc = [...txs].sort(
        (a, b) =>
          a.occurred_at.localeCompare(b.occurred_at) || a.created_at.localeCompare(b.created_at)
      );
      let running = hasSubsetFilter ? 0 : (openingByAccount.get(accId) ?? 0);
      for (const t of asc) {
        running += t.transaction_type === 'income' ? t.amount_minor : -t.amount_minor;
        map[t.id] = running;
      }
    }
    return map;
  }, [filtered, hasSubsetFilter, transactions, accounts]);

  const groups: [string, string[]][] = options
    ? [
        ['Descriptions', (options.descriptions || []).map((x) => x.value)],
        ['Categories', (options.categories || []).map((x) => x.name)],
        ['Payment methods', (options.methods || []).map((x) => x.name)],
        ['Accounts', (options.accounts || []).map((x) => x.name)],
        ['Payees', (options.payees || []).map((x) => x.name)],
        ['Tags', (options.tags || []).map((x) => x.name)],
      ]
    : [];

  const advancedFilterCount = [
    categoryId !== undefined,
    methodId,
    payeeId,
    status,
    tag,
    from,
    to,
  ].filter(Boolean).length;
  const anyFilterActive = Boolean(accountId) || advancedFilterCount > 0;
  const hasDrillFilter = Boolean(filterLabel && anyFilterActive);

  return (
    <main>
      <div className="accountscope">
        <span>Viewing</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      <div className="searchwrap">
        <div className="search">
          <span>⌕</span>
          <input
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPopupOpen(true);
            }}
            onFocus={() => setPopupOpen(true)}
            onBlur={() => window.setTimeout(() => setPopupOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPopupOpen(false);
            }}
            placeholder="Search anything…"
          />
          <button
            onClick={() => {
              setQuery('');
              setPopupOpen(false);
            }}
          >
            ×
          </button>
        </div>
        {options && query.trim() && popupOpen && (
          <div className="searchpopup">
            {groups.map(([label, vals]) =>
              vals.length ? (
                <div key={label}>
                  <label>{label}</label>
                  {vals.slice(0, 8).map((v) => (
                    <button
                      key={v}
                      onClick={() => {
                        const terms = query
                          .split(/\s+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        const vLower = v.toLowerCase();
                        if (!terms.some((t) => t.toLowerCase() === vLower)) terms.push(v);
                        setQuery(terms.join(' '));
                        setPopupOpen(false);
                      }}
                    >
                      {v}
                      <span>⌕</span>
                    </button>
                  ))}
                </div>
              ) : null
            )}
            {groups.every(([, v]) => !v.length) && (
              <div className="popupempty">No matching saved values</div>
            )}
          </div>
        )}
      </div>

      {hasDrillFilter && (
        <div className="filterchip">
          <span>Filtered: {filterLabel}</span>
          <button className="outline" onClick={clearAllFilters}>
            Clear filter
          </button>
        </div>
      )}

      <div className="filterline">
        <span>{filtered.length} entries</span>
        <div className="filtertools">
          <div className="segmented small">
            {(
              [
                ['all', 'All'],
                ['expense', 'Expense'],
                ['income', 'Income'],
              ] as const
            ).map(([id, l]) => (
              <button
                key={id}
                className={type === id ? 'selected' : ''}
                onClick={() => setType(id)}
              >
                {l}
              </button>
            ))}
          </div>
          <button
            className={`outline filtersbtn${advancedFilterCount ? ' active' : ''}`}
            onClick={() => setShowFilters((v) => !v)}
          >
            ⚙ Filters{advancedFilterCount ? ` (${advancedFilterCount})` : ''}
          </button>
        </div>
      </div>

      {showFilters && (
        <section className="card filterpanel">
          <div className="datepresets">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setFrom(p.from());
                  setTo(p.to());
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="filtergrid">
            <label className="field">
              <span>Payment method</span>
              <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                <option value="">Any method</option>
                {accountMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Category</span>
              <select
                value={categoryId === undefined ? '' : (categoryId ?? '__uncat')}
                onChange={(e) => {
                  const v = e.target.value;
                  setCategoryId(v === '' ? undefined : v === '__uncat' ? null : v);
                }}
              >
                <option value="">Any category</option>
                <option value="__uncat">Uncategorized</option>
                {roots.map((r) => (
                  <optgroup key={r.id} label={r.name}>
                    <option value={r.id}>{r.name}</option>
                    {categoryChildren(categories, r.id).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Payee / payer</span>
              <select value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
                <option value="">Anyone</option>
                {payees.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as '' | 'cleared' | 'uncleared')}
              >
                <option value="">Any status</option>
                <option value="cleared">Cleared</option>
                <option value="uncleared">Uncleared</option>
              </select>
            </label>
            <label className="field">
              <span>Tag</span>
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Any tag</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    #{t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>From</span>
              <input
                type="date"
                value={toDateInput(from)}
                onChange={(e) => setFrom(e.target.value ? fromDateInput(e.target.value) : '')}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="date"
                value={to ? toDateInput(to) : ''}
                onChange={(e) => setTo(e.target.value ? endOfDayIso(e.target.value) : null)}
              />
            </label>
          </div>
          <div className="iorow close">
            <button
              className="outline"
              onClick={clearAllFilters}
              disabled={!advancedFilterCount && !accountId}
            >
              Clear all filters
            </button>
          </div>
        </section>
      )}

      <section className="card activity-card">
        {filtered.map((t) => (
          <TxRow
            key={t.id}
            t={t}
            balance={balanceById[t.id]}
            balanceLabel={hasSubsetFilter ? 'Net' : 'Bal'}
            onClick={() => open({ kind: 'detail', id: t.id })}
            onOpenRef={(refId) => open({ kind: 'detail', id: refId })}
          />
        ))}
        {!filtered.length && <Empty text="No matching transactions." />}
      </section>
    </main>
  );
}
