import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import type { SearchOptions } from './api';
import { useDebounce } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';

export function Activity() {
  const { transactions, open } = useStore();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'all' | 'expense' | 'income'>('all');
  const debounced = useDebounce(query, 180);
  const [options, setOptions] = useState<SearchOptions | null>(null);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = transactions;
    if (type !== 'all') list = list.filter((t) => t.transaction_type === type);
    if (!q) return list;
    return list.filter((t) =>
      [
        t.description,
        t.note,
        t.category_name,
        t.account_name,
        t.payment_method_name,
        t.payee_name,
        t.reference_number,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [transactions, query, type]);

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

      <div className="filterline">
        <span>{filtered.length} entries</span>
        <div className="segmented mini">
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
          <TxRow key={t.id} t={t} onClick={() => open({ kind: 'detail', id: t.id })} />
        ))}
        {!filtered.length && <Empty text="No matching transactions." />}
      </section>
    </main>
  );
}
