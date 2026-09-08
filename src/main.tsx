import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Account = { id: string; name: string; opening_balance_minor: number; balance_minor?: number };
type Category = { id: string; name: string; parent_id: string | null; kind: 'expense' | 'income' | 'both' };
type Method = { id: string; name: string; account_id: string };
type Payee = { id: string; name: string };
type Tx = { id: string; occurred_at: string; description: string; note: string; category_name: string | null; account_name: string; payment_method_name: string | null; payee_name?: string | null; amount_minor: number; transaction_type: 'expense' | 'income'; status: string; account_id: string; category_id: string | null; payment_method_id: string | null };
type Audit = { id: string; occurred_at: string; entity_type: string; entity_id: string; action: string; before_json: string | null; after_json: string | null };

const money = (n: number) => `₹${(n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dtLocal = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function api(path: string, options?: RequestInit) {
  const r = await fetch(path, options);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function App() {
  const [page, setPage] = useState<'dashboard' | 'activity' | 'manage'>('dashboard');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [dash, setDash] = useState<any>(null);
  const [modal, setModal] = useState<any>(null);
  const [query, setQuery] = useState('');
  const [searchOptions, setSearchOptions] = useState<any>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const b = await api('/api/bootstrap');
      const [d, t] = await Promise.all([api('/api/dashboard'), api('/api/transactions?limit=500')]);
      setAccounts(b.accounts || []);
      setCategories(b.categories || []);
      setMethods(b.paymentMethods || []);
      setPayees(b.payees || []);
      setSuggestions(b.suggestions || []);
      setDash(d);
      setTxs(t || []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load');
    }
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (!query.trim()) { setSearchOptions(null); return; }
    const timer = window.setTimeout(() => {
      api('/api/search-options?q=' + encodeURIComponent(query)).then(setSearchOptions).catch(() => setSearchOptions(null));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return txs;
    return txs.filter(t => [t.description, t.note, t.category_name, t.account_name, t.payment_method_name, t.payee_name]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [txs, query]);

  const saved = async () => { setModal(null); await refresh(); };

  return <div className="app">
    <header>
      <div><div className="eyebrow">EXPENSE MANAGER</div><h1>{page === 'dashboard' ? 'Dashboard' : page === 'activity' ? 'Activity' : 'Manage'}</h1></div>
      <button className="gear" onClick={() => setPage('manage')}>⚙</button>
    </header>
    {error && <div className="error">{error}</div>}
    {page === 'dashboard' && <Dashboard dash={dash} txs={txs} goActivity={() => setPage('activity')} openTx={t => setModal({ kind: 'detail', id: t.id })} />}
    {page === 'activity' && <Activity txs={filtered} query={query} setQuery={setQuery} options={searchOptions} choose={setQuery} openTx={t => setModal({ kind: 'detail', id: t.id })} />}
    {page === 'manage' && <Manage accounts={accounts} categories={categories} methods={methods} onOpen={setModal} />}
    <button className="fab" onClick={() => setModal({ kind: 'tx' })}>＋</button>
    <nav>
      <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>⌂<span>Dashboard</span></button>
      <button className={page === 'activity' ? 'active' : ''} onClick={() => setPage('activity')}>☷<span>Activity</span></button>
      <button className={page === 'manage' ? 'active' : ''} onClick={() => setPage('manage')}>⚙<span>Manage</span></button>
    </nav>
    {modal?.kind === 'tx' && <TransactionForm accounts={accounts} categories={categories} methods={methods} payees={payees} suggestions={suggestions} close={() => setModal(null)} saved={saved} needAccount={() => setModal({ kind: 'account' })} title="Add transaction" />}
    {modal?.kind === 'detail' && <TransactionDetail id={modal.id} close={() => setModal(null)} edit={id => setModal({ kind: 'editTx', id })} deleted={saved} />}
    {modal?.kind === 'editTx' && <TransactionEdit id={modal.id} accounts={accounts} categories={categories} methods={methods} close={() => setModal(null)} saved={saved} />}
    {modal?.kind === 'account' && <AccountModal item={modal.item} close={() => setModal(null)} saved={saved} />}
    {modal?.kind === 'category' && <CategoryModal item={modal.item} categories={categories} close={() => setModal(null)} saved={saved} />}
    {modal?.kind === 'method' && <MethodModal item={modal.item} accounts={accounts} close={() => setModal(null)} saved={saved} />}
    {modal?.kind === 'audit' && <AuditPage close={() => setModal(null)} />}
  </div>;
}

function Dashboard({ dash, txs, goActivity, openTx }: { dash: any; txs: Tx[]; goActivity: () => void; openTx: (t: Tx) => void }) {
  const cats = Object.entries(dash?.categories || {}).sort((a: any, b: any) => b[1] - a[1]);
  const max = (cats[0]?.[1] as number) || 1;
  return <main>
    <div className="stats">
      <div><small>THIS WEEK · INCOME</small><b className="positive">{money(dash?.week?.income || 0)}</b></div>
      <div><small>THIS WEEK · EXPENSE</small><b>{money(dash?.week?.expense || 0)}</b></div>
      <div><small>THIS MONTH · NET</small><b className={(dash?.month?.income || 0) >= (dash?.month?.expense || 0) ? 'positive' : ''}>{money((dash?.month?.income || 0) - (dash?.month?.expense || 0))}</b></div>
    </div>
    <section className="card"><div className="cardhead"><div><h2>Expenses by category</h2><p>This month</p></div></div>
      {cats.length ? <div className="bars">{cats.map(([n, v]: any) => <div className="bar" key={n}><span>{n}</span><i style={{ width: `${Math.max(7, v / max * 100)}%` }}></i><b>{money(v)}</b></div>)}</div> : <Empty text="No expenses recorded this month." />}
    </section>
    <section className="card"><div className="cardhead"><h2>Recent activity</h2><button className="link" onClick={goActivity}>View all →</button></div>
      {txs.slice(0, 7).map(t => <TxRow key={t.id} t={t} onClick={() => openTx(t)} />)}
      {!txs.length && <Empty text="No transactions yet." />}
    </section>
  </main>;
}

function Activity({ txs, query, setQuery, options, choose, openTx }: { txs: Tx[]; query: string; setQuery: (s: string) => void; options: any; choose: (s: string) => void; openTx: (t: Tx) => void }) {
  return <main><div className="searchwrap"><div className="search"><span>⌕</span><input autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search anything…"/><button onClick={() => setQuery('')}>×</button></div>{options && <SearchPopup options={options} choose={choose} />}</div>
    <div className="filterline"><span>{txs.length} entries</span><span>Searches description, note, category, payment method, account and payee</span></div>
    <section className="card activity-card">{txs.map(t => <TxRow key={t.id} t={t} onClick={() => openTx(t)} />)}{!txs.length && <Empty text="No matching transactions."/>}</section>
  </main>;
}

function SearchPopup({ options, choose }: { options: any; choose: (s: string) => void }) {
  const groups: [string, string[]][] = [
    ['Descriptions', options.descriptions?.map((x: any) => x.value) || []],
    ['Categories', options.categories?.map((x: any) => x.name) || []],
    ['Payment methods', options.methods?.map((x: any) => x.name) || []],
    ['Accounts', options.accounts?.map((x: any) => x.name) || []],
    ['Payees', options.payees?.map((x: any) => x.name) || []]
  ];
  return <div className="searchpopup">{groups.map(([label, vals]) => vals.length ? <div key={label}><label>{label}</label>{vals.slice(0, 8).map(v => <button key={v} onClick={() => choose(v)}>{v}<span>⌕</span></button>)}</div> : null)}{groups.every(([, v]) => !v.length) && <div className="popupempty">No matching saved values</div>}</div>;
}

function TxRow({ t, onClick }: { t: Tx; onClick: () => void }) {
  return <button className="tx" onClick={onClick}><div className="avatar">{(t.description || t.payee_name || t.category_name || '?')[0].toUpperCase()}</div><div className="txmain"><strong>{t.description || t.payee_name || '(No description)'}</strong><span>{t.category_name || 'Uncategorized'}{t.payee_name ? ` · ${t.payee_name}` : ''}</span><small>{new Date(t.occurred_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {t.account_name}{t.payment_method_name ? ` · ${t.payment_method_name}` : ''}</small></div><b className={t.transaction_type === 'income' ? 'positive' : ''}>{t.transaction_type === 'income' ? '+' : '−'}{money(t.amount_minor)}</b></button>;
}

function Manage({ accounts, categories, methods, onOpen }: { accounts: Account[]; categories: Category[]; methods: Method[]; onOpen: (m: any) => void }) {
  const [tab, setTab] = useState<'accounts' | 'categories' | 'methods'>('accounts');
  const [kind, setKind] = useState<'all' | 'expense' | 'income'>('all');
  const shown = categories.filter(c => kind === 'all' || c.kind === kind || c.kind === 'both');
  return <main><div className="manage-tabs">{[['accounts', 'Accounts'], ['categories', 'Categories'], ['methods', 'Payment methods']].map(([id, label]) => <button className={tab === id ? 'selected' : ''} onClick={() => setTab(id as any)} key={id}>{label}</button>)}<button onClick={() => onOpen({ kind: 'audit' })}>Audit log</button></div>
    {tab === 'accounts' && <section className="card manager"><div className="managerhead"><div><h2>Accounts</h2><p>Balances and account-specific payment methods.</p></div><button className="primary" onClick={() => onOpen({ kind: 'account' })}>＋ Add account</button></div>{accounts.map(a => <div className="manage-row" key={a.id}><div className="roundicon">▣</div><div><strong>{a.name}</strong><span>Balance {money(a.balance_minor ?? a.opening_balance_minor)}</span></div><button className="outline" onClick={() => onOpen({ kind: 'account', item: a })}>Edit</button></div>)}{!accounts.length && <Empty text="No accounts yet."/>}</section>}
    {tab === 'categories' && <section className="card manager"><div className="managerhead"><div><h2>Categories</h2><p>Build a clear hierarchy for expenses and income.</p></div><button className="primary" onClick={() => onOpen({ kind: 'category' })}>＋ Add category</button></div><div className="segmented">{[['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([id, l]) => <button className={kind === id ? 'selected' : ''} onClick={() => setKind(id as any)} key={id}>{l}</button>)}</div><CategoryTree categories={shown} edit={c => onOpen({ kind: 'category', item: c })}/>{!shown.length && <Empty text="No categories in this view."/>}</section>}
    {tab === 'methods' && <section className="card manager"><div className="managerhead"><div><h2>Payment methods</h2><p>Methods are grouped by the account they belong to.</p></div><button className="primary" onClick={() => onOpen({ kind: 'method' })}>＋ Add payment method</button></div>{accounts.map(a => { const ms = methods.filter(m => m.account_id === a.id); return <div className="methodgroup" key={a.id}><div className="grouptitle"><strong>{a.name}</strong><span>{ms.length}</span></div>{ms.map(m => <div className="manage-row compact" key={m.id}><div className="roundicon">◌</div><div><strong>{m.name}</strong><span>Payment method</span></div><button className="outline" onClick={() => onOpen({ kind: 'method', item: m })}>Edit</button></div>)}{!ms.length && <div className="groupempty">No methods for this account.</div>}</div>; })}{!accounts.length && <Empty text="Create an account before adding payment methods."/>}</section>}
  </main>;
}

function CategoryTree({ categories, edit }: { categories: Category[]; edit: (c: Category) => void }) {
  const roots = categories.filter(c => !c.parent_id);
  return <div className="catlist">{roots.map(r => { const children = categories.filter(c => c.parent_id === r.id); const kindLabel = r.kind === 'both' ? 'Expense + Income' : r.kind === 'income' ? 'Income' : 'Expense'; return <div className="catgroup" key={r.id}><div className="catrow root"><div className="catdot">{r.kind === 'income' ? '↗' : r.kind === 'expense' ? '↘' : '↕'}</div><div><strong>{r.name}</strong><span>{kindLabel} · {children.length} subcategor{children.length === 1 ? 'y' : 'ies'}</span></div><button className="outline" onClick={() => edit(r)}>Edit</button></div>{children.map(c => <div className="catrow child" key={c.id}><div className="branch">└</div><div className="catdot small">{c.kind === 'income' ? '↗' : c.kind === 'expense' ? '↘' : '↕'}</div><div><strong>{c.name}</strong><span>{c.kind === 'both' ? 'Expense + Income' : c.kind === 'income' ? 'Income' : 'Expense'}</span></div><button className="outline" onClick={() => edit(c)}>Edit</button></div>)}</div>; })}</div>;
}

function TransactionForm({ accounts, categories, methods, payees, suggestions, close, saved, needAccount, title, initial, id: txid }: { accounts: Account[]; categories: Category[]; methods: Method[]; payees: Payee[]; suggestions: string[]; close: () => void; saved: () => void; needAccount?: () => void; title: string; initial?: any; id?: string }) {
  const [type, setType] = useState<'expense' | 'income'>(initial?.transaction_type || 'expense');
  const [accountId, setAccountId] = useState(initial?.account_id || accounts[0]?.id || '');
  const [categoryId, setCategoryId] = useState(initial?.category_id || '');
  const [methodId, setMethodId] = useState(initial?.payment_method_id || '');
  const [amount, setAmount] = useState(initial ? String(initial.amount_minor / 100) : '');
  const [date, setDate] = useState(initial ? new Date(initial.occurred_at).toISOString().slice(0, 16) : dtLocal());
  const [description, setDescription] = useState(initial?.description || '');
  const [note, setNote] = useState(initial?.note || '');
  const [payee, setPayee] = useState(initial?.payee_name || '');
  const [status, setStatus] = useState(initial?.status || 'cleared');
  const [catOpen, setCatOpen] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const cats = categories.filter(c => c.kind === 'both' || c.kind === type);
  const roots = cats.filter(c => !c.parent_id);
  const ms = methods.filter(m => m.account_id === accountId);

  useEffect(() => { if (!ms.some(m => m.id === methodId)) setMethodId(''); }, [accountId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const payload = { type, accountId, categoryId: categoryId || null, methodId: methodId || null, amount, occurredAt: new Date(date).toISOString(), description, note, payee, status };
      await api(txid ? `/api/transactions/${txid}` : '/api/transactions', { method: txid ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      await saved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Unable to save');
    } finally {
      setSaving(false);
    }
  };

  return <div className="overlay"><div className="modal formmodal"><div className="modalhead"><div><h2>{title}</h2><p>{txid ? 'Edit transaction' : 'Record a new transaction'}</p></div><button onClick={close}>×</button></div>{err && <div className="error">{err}</div>}
    {!accounts.length ? <div className="empty"><p>You need an account first.</p><button className="primary" onClick={needAccount}>Create account</button></div> : <form onSubmit={submit}>
      <div className="typechoice"><button type="button" className={type === 'expense' ? 'chosen' : ''} onClick={() => setType('expense')}>− <b>Expense</b><span>Money going out</span></button><button type="button" className={type === 'income' ? 'chosen incomechoice' : ''} onClick={() => setType('income')}>＋ <b>Income</b><span>Money coming in</span></button></div>
      <label className="amount"><span>Amount</span><div>₹<input required min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"/></div></label>
      <div className="formgrid">
        <Field label="Date & time"><input type="datetime-local" value={date} onChange={e => setDate(e.target.value)}/></Field>
        <Field label="Account"><select required value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Payment method"><select value={methodId} onChange={e => setMethodId(e.target.value)}><option value="">Any / none</option>{ms.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></Field>
        <div className="field relative"><label>Category</label><button type="button" className="picker" onClick={() => setCatOpen(!catOpen)}>{categoryId ? categories.find(c => c.id === categoryId)?.name : 'Select category'}<span>⌄</span></button>{catOpen && <div className="pickerpanel">{roots.map(r => <div key={r.id}><button type="button" className="catpick rootpick" onClick={() => { setCategoryId(r.id); setCatOpen(false); }}>{r.name}<span>{r.kind}</span></button>{cats.filter(c => c.parent_id === r.id).map(c => <button type="button" className="catpick childpick" key={c.id} onClick={() => { setCategoryId(c.id); setCatOpen(false); }}>↳ {c.name}</button>)}</div>)}{!roots.length && <p>No categories available.</p>}</div>}</div>
        <Field label="Payee / payer"><input value={payee} onChange={e => setPayee(e.target.value)} list="payees" placeholder="Who was this with?"/><datalist id="payees">{payees.map(p => <option key={p.id} value={p.name}/>)}</datalist></Field>
      </div>
      <div className="details"><h3>Details</h3><div className="relative"><label>Description</label><input value={description} onFocus={() => setDescOpen(true)} onChange={e => { setDescription(e.target.value); setDescOpen(true); }} placeholder="e.g. Groceries at Nature's Basket" list="descriptions"/><datalist id="descriptions">{suggestions.map(s => <option key={s} value={s}/>)}</datalist>{descOpen && description && <div className="descpopup">{suggestions.filter(s => s.toLowerCase().startsWith(description.toLowerCase())).slice(0, 7).map(s => <button type="button" key={s} onClick={() => { setDescription(s); setDescOpen(false); }}>{s}</button>)}</div>}</div><label>Note<input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note"/></label></div>
      <div className="statusrow"><span>Status</span><button type="button" className={status === 'cleared' ? 'active' : ''} onClick={() => setStatus('cleared')}>✓ Cleared</button><button type="button" className={status === 'uncleared' ? 'active' : ''} onClick={() => setStatus('uncleared')}>○ Uncleared</button></div>
      <button className="save" disabled={saving}>{saving ? 'Saving…' : txid ? 'Save changes' : 'Save transaction'}</button>
    </form>}
  </div></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }

function TransactionDetail({ id, close, edit, deleted }: { id: string; close: () => void; edit: (id: string) => void; deleted: () => void }) {
  const [tx, setTx] = useState<any>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { Promise.all([api(`/api/transactions/${id}`), api(`/api/transactions/${id}/audit`)]).then(([t, a]) => { setTx(t); setAudit(a); }).catch(() => {}); }, [id]);
  if (!tx) return <div className="overlay"><div className="modal"><div className="loading">Loading…</div></div></div>;
  const fmt = (j: string | null) => { if (!j) return ''; try { return JSON.parse(j); } catch { return j; } };
  return <div className="overlay"><div className="modal detailmodal"><div className="modalhead"><div><span className="eyebrow">TRANSACTION</span><h2>{tx.description || tx.payee_name || 'Transaction'}</h2></div><button onClick={close}>×</button></div><div className="detailamount"><b className={tx.transaction_type === 'income' ? 'positive' : ''}>{tx.transaction_type === 'income' ? '+' : '−'}{money(tx.amount_minor)}</b><span>{tx.transaction_type === 'income' ? 'Income' : 'Expense'} · {tx.status}</span></div><div className="detailgrid"><Detail label="Date & time" value={new Date(tx.occurred_at).toLocaleString('en-IN')}/><Detail label="Account" value={tx.account_name}/><Detail label="Payment method" value={tx.payment_method_name || '—'}/><Detail label="Category" value={tx.category_name || 'Uncategorized'}/><Detail label="Payee / payer" value={tx.payee_name || '—'}/><Detail label="Description" value={tx.description || '—'}/><Detail label="Note" value={tx.note || '—'}/><Detail label="Status" value={tx.status}/></div><section className="history"><div className="cardhead"><div><h3>Transaction history</h3><p>Every change is preserved in the audit log.</p></div></div>{audit.map(a => <div className="audititem" key={a.id}><div className="timeline"></div><div><strong>{a.action[0].toUpperCase() + a.action.slice(1)}</strong><small>{new Date(a.occurred_at).toLocaleString('en-IN')}</small>{a.action === 'update' && <pre>{JSON.stringify({ before: fmt(a.before_json), after: fmt(a.after_json) }, null, 2)}</pre>}</div></div>)}{!audit.length && <Empty text="No history recorded."/>}</section><div className="detailactions"><button className="outline" onClick={() => edit(id)}>Edit</button><button className="danger" onClick={() => setConfirm(true)}>Delete</button></div>{confirm && <div className="confirm"><p>Delete this transaction? It will be hidden from activity but retained in the audit log.</p><button className="outline" onClick={() => setConfirm(false)}>Cancel</button><button className="danger" onClick={async () => { await api(`/api/transactions/${id}`, { method: 'DELETE' }); await deleted(); }}>Delete transaction</button></div>}</div></div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="detail"><span>{label}</span><strong>{value}</strong></div>; }

function AuditPage({ close }: { close: () => void }) {
  const [rows, setRows] = useState<Audit[]>([]);
  useEffect(() => { api('/api/audit').then(setRows).catch(() => setRows([])); }, []);
  return <div className="overlay"><div className="modal auditmodal"><div className="modalhead"><div><h2>Audit log</h2><p>Complete change history for your data.</p></div><button onClick={close}>×</button></div>{rows.map(a => <div className="globalaudit" key={a.id}><div className="auditbadge">{a.action === 'create' ? '＋' : a.action === 'update' ? '↻' : '−'}</div><div><strong>{a.action} · {a.entity_type}</strong><span>{new Date(a.occurred_at).toLocaleString('en-IN')} · {a.entity_id}</span></div></div>)}{!rows.length && <Empty text="No audit events yet."/>}</div></div>;
}

function AccountModal({ item, close, saved }: { item?: Account; close: () => void; saved: () => void }) {
  return <SimpleModal title={item ? 'Edit account' : 'Add account'} close={close} onSave={async v => { await api(item ? `/api/accounts/${item.id}` : '/api/accounts', { method: item ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) }); await saved(); }} fields={[[ 'name', 'Account name', item?.name || '' ], [ 'openingBalance', 'Opening balance', item ? String(item.opening_balance_minor / 100) : '0' ]]} />;
}

function CategoryModal({ item, categories, close, saved }: { item?: Category; categories: Category[]; close: () => void; saved: () => void }) {
  return <div className="overlay"><div className="modal"><div className="modalhead"><div><h2>{item ? 'Edit category' : 'Add category'}</h2><p>Categories can be expense, income, or both.</p></div><button onClick={close}>×</button></div><CategoryForm item={item} categories={categories} saved={saved}/></div></div>;
}

function CategoryForm({ item, categories, saved }: { item?: Category; categories: Category[]; saved: () => void }) {
  const [name, setName] = useState(item?.name || '');
  const [kind, setKind] = useState<'expense' | 'income' | 'both'>(item?.kind || 'expense');
  const [parent, setParent] = useState(item?.parent_id || '');
  return <form onSubmit={async e => { e.preventDefault(); await api(item ? `/api/categories/${item.id}` : '/api/categories', { method: item ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, kind, parentId: parent || null }) }); await saved(); }}><Field label="Name"><input required value={name} onChange={e => setName(e.target.value)}/></Field><Field label="Type"><select value={kind} onChange={e => setKind(e.target.value as any)}><option value="expense">Expense</option><option value="income">Income</option><option value="both">Expense + Income</option></select></Field><Field label="Parent category"><select value={parent} onChange={e => setParent(e.target.value)}><option value="">No parent — top level</option>{categories.filter(c => !c.parent_id && c.id !== item?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><button className="save">Save category</button></form>;
}

function MethodModal({ item, accounts, close, saved }: { item?: Method; accounts: Account[]; close: () => void; saved: () => void }) {
  return <SimpleModal title={item ? 'Edit payment method' : 'Add payment method'} close={close} onSave={async v => { await api(item ? `/api/payment-methods/${item.id}` : '/api/payment-methods', { method: item ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) }); await saved(); }} fields={[[ 'name', 'Payment method', item?.name || '' ], [ 'accountId', 'Account', item?.account_id || accounts[0]?.id || '', accounts.map(a => ({ value: a.id, label: a.name })) ]]} />;
}

function SimpleModal({ title, close, onSave, fields }: { title: string; close: () => void; onSave: (v: any) => Promise<void>; fields: any[] }) {
  const [v, setV] = useState<any>(Object.fromEntries(fields.map(f => [f[0], f[2] || ''])));
  const [saving, setSaving] = useState(false);
  return <div className="overlay"><div className="modal"><div className="modalhead"><h2>{title}</h2><button onClick={close}>×</button></div><form onSubmit={async e => { e.preventDefault(); setSaving(true); try { await onSave(v); } catch (err) { console.error(err); } finally { setSaving(false); } }}>{fields.map(f => <Field key={f[0]} label={f[1]}>{Array.isArray(f[3]) ? <select required value={v[f[0]]} onChange={e => setV({ ...v, [f[0]]: e.target.value })}>{f[3].map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <input required value={v[f[0]]} onChange={e => setV({ ...v, [f[0]]: e.target.value })}/>}</Field>)}<button className="save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></form></div></div>;
}

function TransactionEdit({ id, accounts, categories, methods, close, saved }: { id: string; accounts: Account[]; categories: Category[]; methods: Method[]; close: () => void; saved: () => void }) {
  const [tx, setTx] = useState<any>(null);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => { Promise.all([api(`/api/transactions/${id}`), api('/api/bootstrap')]).then(([t, b]) => { setTx(t); setPayees(b.payees || []); setSuggestions(b.suggestions || []); }).catch(() => {}); }, [id]);
  return tx ? <TransactionForm accounts={accounts} categories={categories} methods={methods} payees={payees} suggestions={suggestions} close={close} saved={saved} title="Edit transaction" initial={tx} id={id}/> : <div className="overlay"><div className="modal">Loading…</div></div>;
}

function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
createRoot(document.getElementById('root')!).render(<App/>);
