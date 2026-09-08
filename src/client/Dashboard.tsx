import { useStore } from './store';
import { money } from './lib';
import { Empty } from './ui';
import { TxRow } from './TxRow';

export function Dashboard() {
  const { dash, transactions, go, open } = useStore();
  const cats = Object.entries(dash?.categories || {}).sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] || 1;
  const month = dash?.month || { income: 0, expense: 0 };
  const net = month.income - month.expense;

  return (
    <main>
      <div className="stats">
        <div>
          <small>THIS WEEK · INCOME</small>
          <b className="positive">{money(dash?.week?.income || 0)}</b>
        </div>
        <div>
          <small>THIS WEEK · EXPENSE</small>
          <b>{money(dash?.week?.expense || 0)}</b>
        </div>
        <div>
          <small>THIS MONTH · NET</small>
          <b className={net >= 0 ? 'positive' : ''}>{money(net)}</b>
        </div>
        <div>
          <small>YTD · NET</small>
          <b className={(dash?.ytd?.income || 0) - (dash?.ytd?.expense || 0) >= 0 ? 'positive' : ''}>
            {money((dash?.ytd?.income || 0) - (dash?.ytd?.expense || 0))}
          </b>
        </div>
      </div>

      {dash?.balances?.length ? (
        <section className="card">
          <div className="cardhead">
            <h2>Account balances</h2>
          </div>
          <div className="balances">
            {dash.balances.map((a) => {
              const bal = a.balance_minor ?? a.opening_balance_minor;
              return (
                <div className="balance" key={a.id}>
                  <span>{a.name}</span>
                  <b className={bal < 0 ? '' : 'positive'}>{money(bal)}</b>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="card">
        <div className="cardhead">
          <div>
            <h2>Expenses by category</h2>
            <p>This month</p>
          </div>
        </div>
        {cats.length ? (
          <div className="bars">
            {cats.map(([n, v]) => (
              <div className="bar" key={n}>
                <span>{n}</span>
                <i style={{ width: `${Math.max(7, (v / max) * 100)}%` }}></i>
                <b>{money(v)}</b>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="No expenses recorded this month." />
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
          <TxRow key={t.id} t={t} onClick={() => open({ kind: 'detail', id: t.id })} />
        ))}
        {!transactions.length && <Empty text="No transactions yet." />}
      </section>
    </main>
  );
}
