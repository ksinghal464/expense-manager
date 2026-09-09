import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import type { SearchOptions } from './api';
import { useDebounce } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';

export function Activity() {
  const { transactions, accounts, open, pendingActivityFilter, clearActivityFilter } = useStore();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | 'expense' | 'income'>('all');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState<string | null | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [filterLabel, setFilterLabel] = useState('');
  const debounced = useDebounce(query, 180);
  const [options, setOptions] = useState<SearchOptions | null>(null);

  // Apply a filter handed off from the Dashboard (e.g. "this week's expenses",
  // an account balance, or a category bar), then clear it so it doesn't stick
  // around on the next manual visit to Activity.
  useEffect(() => {
    if (!pendingActivityFilter) return;
    const f = pendingActivityFilter;
    setType(f.type || 'all');
    setAccountId(f.accountId || '');
    setCategoryId(f.categoryId);
    setFrom(f.from || '');
    setTo(f.to ?? null);
    setFilterLabel(f.label || '');
    clearActivityFilter();
  }, [pendingActivityFilter, clearActivityFilter]);

  // server-side search suggestions while typing
  useEffect(() => {
    if (!debounced.trim()) {
      setOptions(null);
      return;
    }
    api
      .searchOptions(debounced.trim())
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [debounced]);

  // Running balance (total opening balances + cumulative net so far), computed
  // over every loaded transaction in chronological order regardless of the
  // filters/search currently applied, then looked up per row below.
  const balanceById = useMemo(() => {
    const openingTotal = accounts.reduce((s, a) => s + a.opening_balance_minor, 0);
    const asc = [...transactions].sort(
      (a, b) =>
        a.occurred_at.localeCompare(b.occurred_at) || a.created_at.localeCompare(b.created_at)
    );
    const map: Record<string, number> = {};
    let running = openingTotal;
    for (const t of asc) {
      running += t.transaction_type === 'income' ? t.amount_minor : -t.amount_minor;
      map[t.id] = running;
    }
    return map;
  }, [transactions, accounts]);

  const clearAllFilters = () => {
    setType('all');
    setAccountId('');
    setCategoryId(undefined);
    setFrom('');
    setTo(null);
    setFilterLabel('');
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = transactions;
    if (type !== 'all') list = list.filter((t) => t.transaction_type === type);
    if (accountId) list = list.filter((t) => t.account_id === accountId);
    if (categoryId !== undefined) list = list.filter((t) => (t.category_id || null) === categoryId);
    if (from) list = list.filter((t) => t.occurred_at >= from);
    if (to) list = list.filter((t) => t.occurred_at < to);
    if (!q) return list;
    return list.filter((t) =>
      [t.description, t.note, t.category_name, t.account_name, t.payment_method_name, t.payee_name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [transactions, query, type, accountId, categoryId, from, to]);

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

  const hasDrillFilter = Boolean(accountId || categoryId !== undefined || from || to);

  return (
    <main>
      <div className="searchwrap">
        <div className="search">
          <span>⌕</span>
          <input
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search anything…"
          />
          <button onClick={() => setQuery('')}>×</button>
        </div>
        {options && query.trim() && (
          <div className="searchpopup">
            {groups.map(([label, vals]) =>
              vals.length ? (
                <div key={label}>
                  <label>{label}</label>
                  {vals.slice(0, 8).map((v) => (
                    <button key={v} onClick={() => setQuery(v)}>
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
          <span>Filtered: {filterLabel || 'custom view'}</span>
          <button className="outline" onClick={clearAllFilters}>
            Clear filter
          </button>
        </div>
      )}

      <div className="filterline">
        <span>{filtered.length} entries</span>
        <div className="segmented">
          {(
            [
              ['all', 'All'],
              ['expense', 'Expense'],
              ['income', 'Income'],
            ] as const
          ).map(([id, l]) => (
            <button key={id} className={type === id ? 'selected' : ''} onClick={() => setType(id)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <section className="card activity-card">
        {filtered.map((t) => (
          <TxRow
            key={t.id}
            t={t}
            balance={balanceById[t.id]}
            onClick={() => open({ kind: 'detail', id: t.id })}
            onOpenRef={(refId) => open({ kind: 'detail', id: refId })}
          />
        ))}
        {!filtered.length && <Empty text="No matching transactions." />}
      </section>
    </main>
  );
}
