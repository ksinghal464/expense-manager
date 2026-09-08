import { StoreProvider, useStore, type Page, type Modal } from './store';
import { Overlay, ModalHead } from './ui';
import { Dashboard } from './Dashboard';
import { Activity } from './Activity';
import { Recurring } from './Recurring';
import { Notes } from './Notes';
import { Manage } from './Manage';
import { TxForm } from './TxForm';
import { TxDetail } from './TxDetail';
import { MasterModal } from './master';

const NAV: [Page, string, string][] = [
  ['dashboard', '◙', 'Home'],
  ['activity', '≣', 'Activity'],
  ['recurring', '⟳', 'Recurring'],
  ['notes', '✎', 'Notes'],
  ['manage', '⚙', 'Manage'],
];

function isMaster(m: Modal): boolean {
  return m !== null && ['account', 'category', 'method', 'payee', 'tag'].includes(m.kind);
}

function Shell() {
  const { loading, error, page, go, modal, open, close, notify, accounts, refresh } = useStore();

  return (
    <div className="app">
      <header className="topbar appbar">
        <div className="brand">
          <span className="mark">₹</span>
          <div>
            <h1>Expenses</h1>
            <p>{accounts.length ? 'Your money, at a glance' : 'Create an account to begin'}</p>
          </div>
        </div>
      </header>

      {error ? (
        <div className="error apperror">
          {error}
          <button className="outline" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="pages">
          {page === 'dashboard' && <Dashboard />}
          {page === 'activity' && <Activity />}
          {page === 'recurring' && <Recurring />}
          {page === 'notes' && <Notes />}
          {page === 'manage' && <Manage />}
        </div>
      )}

      {!error && !loading && accounts.length > 0 && (
        <button className="fab" onClick={() => open({ kind: 'tx' })} title="Add transaction" aria-label="Add transaction">
          ＋
        </button>
      )}

      <nav className="tabbar">
        {NAV.map(([id, icon, label]) => (
          <button key={id} className={page === id ? 'selected' : ''} onClick={() => go(id)}>
            <span className="icon">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {modal && modal.kind === 'tx' && (
        <Overlay onClose={close}>
          <ModalHead title="New transaction" onClose={close} />
          <TxForm title="New transaction" close={close} />
        </Overlay>
      )}

      {modal && modal.kind === 'editTx' && (
        <Overlay onClose={close}>
          <ModalHead title="Edit transaction" onClose={close} />
          <TxForm id={modal.id} title="Edit transaction" close={close} />
        </Overlay>
      )}

      {modal && modal.kind === 'detail' && (
        <Overlay wide onClose={close}>
          <ModalHead title="Transaction" onClose={close} />
          <TxDetail id={modal.id} fromTrash={modal.fromTrash} close={close} />
        </Overlay>
      )}

      {modal && isMaster(modal) && <MasterModal modal={modal} close={close} />}

      {notify && <div className="toast">{notify}</div>}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
