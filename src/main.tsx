import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Tx = { date: string; description: string; category: string; account: string; amount: number; type: 'expense' | 'income' };

const sample: Tx[] = [
  { date: 'Today, 14:32', description: 'ABC Restaurant', category: 'Food / Restaurant', account: 'SBI • UPI', amount: 850, type: 'expense' },
  { date: 'Today, 12:15', description: 'Salary', category: 'Income / Salary', account: 'SBI • Bank Transfer', amount: 150000, type: 'income' },
  { date: 'Yesterday, 19:42', description: 'Grocery Store', category: 'Food / Groceries', account: 'Cash • Cash', amount: 2350, type: 'expense' },
];

function App() {
  const [page, setPage] = useState<'dashboard' | 'activity'>('dashboard');
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => sample.filter(t => [t.description, t.category, t.account].join(' ').toLowerCase().includes(query.toLowerCase())), [query]);
  const expenses = sample.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const income = sample.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);

  return <div className="app">
    <header><div><span className="eyebrow">EXPENSE MANAGER</span><h1>{page === 'dashboard' ? 'Dashboard' : 'Activity'}</h1></div><button className="icon">⚙</button></header>
    {page === 'dashboard' ? <>
      <section className="period"><span>September 2026</span><button>⌄</button></section>
      <section className="stats"><div><small>INCOME</small><strong className="income">₹{income.toLocaleString('en-IN')}</strong></div><div><small>EXPENSES</small><strong>₹{expenses.toLocaleString('en-IN')}</strong></div><div><small>NET</small><strong>₹{(income-expenses).toLocaleString('en-IN')}</strong></div></section>
      <section className="card"><div className="section-title"><h2>Expense by category</h2><span>This month</span></div><div className="bars"><div><i style={{width:'82%'}}></i><span>Food</span><b>₹18,200</b></div><div><i style={{width:'54%'}}></i><span>Household</span><b>₹8,500</b></div><div><i style={{width:'46%'}}></i><span>Transport</span><b>₹7,200</b></div><div><i style={{width:'40%'}}></i><span>Shopping</span><b>₹6,800</b></div></div></section>
      <section className="card"><div className="section-title"><h2>Recent activity</h2><button onClick={() => setPage('activity')}>View all →</button></div>{sample.map((t,i)=><TxRow key={i} t={t}/>)}</section>
    </> : <>
      <div className="search"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search description, note, category, account..."/></div>
      <div className="filters"><button>All accounts⌄</button><button>All types⌄</button><button>All dates⌄</button></div>
      <section className="card">{filtered.map((t,i)=><TxRow key={i} t={t}/>)}</section>
    </>}
    <button className="fab" aria-label="Add transaction">＋</button>
    <nav><button className={page==='dashboard'?'active':''} onClick={()=>setPage('dashboard')}>⌂<span>Dashboard</span></button><button className={page==='activity'?'active':''} onClick={()=>setPage('activity')}>≡<span>Activity</span></button><button>▣<span>Accounts</span></button><button>•••<span>More</span></button></nav>
  </div>
}
function TxRow({t}:{t:Tx}) { return <div className="tx"><div className="avatar">{t.description[0]}</div><div className="tx-main"><strong>{t.description}</strong><span>{t.category}</span><small>{t.date} · {t.account}</small></div><b className={t.type==='income'?'income':''}>{t.type==='income'?'+':'−'}₹{t.amount.toLocaleString('en-IN')}</b></div> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
