import { useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { api } from './api';
import { money } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';
import { daysAgo } from '../shared/period';
import type { CategoryTotal } from '../shared/types';

type FrameData = {
  label: string;
  from: string;
  to: string | null;
  income: number;
  expense: number;
};

const EXTRA_PRESETS: { key: string; label: string; from: (now: number) => string }[] = [
  { key: 'last30', label: 'Last 30 days', from: (now) => daysAgo(30, now) },
  { key: 'last12m', label: 'Last 12 months', from: (now) => daysAgo(365, now) },
];

const CAT_PRESETS = ['today', 'week', 'month', 'ytd', 'last30', 'last12m'] as const;

function todayInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function Dashboard() {
  const { dash, transactions, go, open, openActivity } = useStore();

  const builtins = useMemo(() => {
    const map: Record<string, FrameData> = {};
    for (const f of dash?.frames || []) map[f.key] = f;
    return map;
  }, [dash]);

  const [activeKeys, setActiveKeys] = useState<string[]>(['week', 'month']);
  const [extra, setExtra] = useState<Record<string, FrameData>>({});
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(todayInputValue());
  const [showCustom, setShowCustom] = useState(false);

  const frameData = (key: string): FrameData | undefined => builtins[key] || extra[key];

  const addWidget = async (key: string, label: string) => {
    if (activeKeys.includes(key)) return;
    setActiveKeys((cur) => [...cur, key]);
    if (!builtins[key] && !extra[key]) {
      const preset = EXTRA_PRESETS.find((p) => p.key === key);
      if (preset) {
        const from = preset.from(Date.now());
        const stats = await api.dashboardFrame(from, null).catch(() => null);
        if (stats) setExtra((cur) => ({ ...cur, [key]: { label, from, to: null, ...stats } }));
      }
    }
  };

  const addCustomWidget = async () => {
    if (!customFrom) return;
    const from = new Date(customFrom + 'T00:00:00').toISOString();
    const toExclusive = new Date(customTo + 'T00:00:00');
    toExclusive.setDate(toExclusive.getDate() + 1);
    const to = toExclusive.toISOString();
    const key = `custom-${customFrom}-${customTo}`;
    const label = `${customFrom} → ${customTo}`;
    const stats = await api.dashboardFrame(from, to).catch(() => null);
    if (stats) {
      setExtra((cur) => ({ ...cur, [key]: { label, from, to, ...stats } }));
      setActiveKeys((cur) => (cur.includes(key) ? cur : [...cur, key]));
      setShowCustom(false);
    }
  };

  const removeWidget = (key: string) => setActiveKeys((cur) => cur.filter((k) => k !== key));

  const availablePresets = [
    ...['today', 'ytd'].map((key) => ({
      key,
      label: builtins[key]?.label || key,
    })),
    ...EXTRA_PRESETS,
  ].filter((p) => !activeKeys.includes(p.key));

  // ---- category breakdown, with its own timeframe selector ----
  const [catKey, setCatKey] = useState<string>('month');
  const [catData, setCatData] = useState<CategoryTotal[]>(dash?.categories || []);
  useEffect(() => {
    setCatData(dash?.categories || []);
  }, [dash]);
  const onCatKeyChange = async (key: string) => {
    setCatKey(key);
    if (key === 'month') {
      setCatData(dash?.categories || []);
      return;
    }
    let from: string;
    if (key === 'today' || key === 'week' || key === 'ytd') {
      from = builtins[key]?.from || new Date().toISOString();
    } else {
      const preset = EXTRA_PRESETS.find((p) => p.key === key);
      from = preset ? preset.from(Date.now()) : new Date().toISOString();
    }
    const rows = await api.dashboardCategories(from, null).catch(() => []);
    setCatData(rows);
  };
  const max = catData[0]?.total || 1;

  return (
    <main>
      <div className="framegrid">
        {activeKeys.map((key) => {
          const f = frameData(key);
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
                    from: f.from,
                    to: f.to,
                    label: `${f.label} · income`,
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
                    from: f.from,
                    to: f.to,
                    label: `${f.label} · expense`,
                  })
                }
              >
                <span>Expense</span>
                <span className="amt-expense">{money(f.expense)}</span>
              </button>
              <button
                className="framerow balance"
                onClick={() => openActivity({ from: f.from, to: f.to, label: f.label })}
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
            <button key={p.key} onClick={() => addWidget(p.key, p.label)}>
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

      <section className="card">
        <div className="cardhead">
          <div>
            <h2>Expenses by category</h2>
            <p>{builtins[catKey]?.label || (catKey === 'month' ? 'This month' : catKey)}</p>
          </div>
        </div>
        <div className="cattabs">
          {CAT_PRESETS.map((key) => (
            <button
              key={key}
              className={catKey === key ? 'selected' : ''}
              onClick={() => onCatKeyChange(key)}
            >
              {builtins[key]?.label || EXTRA_PRESETS.find((p) => p.key === key)?.label || key}
            </button>
          ))}
        </div>
        {catData.length ? (
          <div className="bars">
            {catData.map((c) => (
              <div
                className="bar"
                key={c.id ?? 'uncategorized'}
                onClick={() =>
                  openActivity({
                    categoryId: c.id,
                    from: frameData(catKey)?.from,
                    label: `${c.name} · ${builtins[catKey]?.label || catKey}`,
                  })
                }
              >
                <span>{c.name}</span>
                <i style={{ width: `${Math.max(7, (c.total / max) * 100)}%` }}></i>
                <b>{money(c.total)}</b>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="No expenses recorded in this period." />
        )}
      </section>

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
