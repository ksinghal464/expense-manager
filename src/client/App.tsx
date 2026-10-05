import { useEffect, useState, type ComponentType } from 'react';
import { StoreProvider, useStore, type Page, type Modal } from './store';
import { Overlay, ModalHead } from './ui';
import { Dashboard } from './Dashboard';
import { Activity } from './Activity';
import { Recurring } from './Recurring';
import { Manage } from './Manage';
import { TxForm } from './TxForm';
import { TxDetail } from './TxDetail';
import { MasterModal } from './master';
import { Login } from './Login';
import { api } from './api';
import {
  IconHome,
  IconList,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconRepeat,
  IconSliders,
  IconSun,
} from './icons';
import {
  THEME_COLORS,
  THEME_KEY,
  nextPref,
  parsePref,
  resolveTheme,
  type ThemePref,
} from './theme';

const NAV: [Page, ComponentType<{ size?: number }>, string][] = [
  ['dashboard', IconHome, 'Home'],
  ['activity', IconList, 'Activity'],
  ['recurring', IconRepeat, 'Recurring'],
  ['manage', IconSliders, 'Manage'],
];

const THEME_LABEL: Record<ThemePref, string> = {
  auto: 'Theme: match system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};
const THEME_ICON: Record<ThemePref, ComponentType<{ size?: number }>> = {
  auto: IconMonitor,
  light: IconSun,
  dark: IconMoon,
};

/** Applies the theme preference to <html data-theme> and follows the system setting in auto. */
function useTheme(): [ThemePref, () => void] {
  const [pref, setPref] = useState<ThemePref>(() => {
    try {
      return parsePref(localStorage.getItem(THEME_KEY));
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = resolveTheme(pref, mq.matches);
      document.documentElement.dataset.theme = theme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLORS[theme]);
    };
    apply();
    if (pref !== 'auto') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
  const cycle = () => {
    const next = nextPref(pref);
    setPref(next);
    try {
      if (next === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // storage disabled: the choice lasts until reload
    }
  };
  return [pref, cycle];
}

function isMaster(m: Modal): boolean {
  return m !== null && ['account', 'category', 'method', 'payee', 'tag'].includes(m.kind);
}

function Shell() {
  const { loading, error, needsLogin, page, go, modal, open, close, notify, accounts, refresh } =
    useStore();
  const [themePref, cycleTheme] = useTheme();
  const ThemeIcon = THEME_ICON[themePref];

  if (needsLogin) return <Login />;

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
        <div className="appbar-actions">
          <button
            className="outline iconbtn"
            onClick={cycleTheme}
            title={THEME_LABEL[themePref]}
            aria-label={THEME_LABEL[themePref]}
          >
            <ThemeIcon size={18} />
          </button>
          <button
            className="outline logoutbtn"
            onClick={async () => {
              await api.logout().catch(() => {});
              window.location.reload();
            }}
          >
            <IconLogout size={16} />
            <span>Log out</span>
          </button>
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
          {page === 'manage' && <Manage />}
        </div>
      )}

      {!error && !loading && accounts.length > 0 && (
        <button
          className="fab"
          onClick={() => open({ kind: 'tx' })}
          title="Add transaction"
          aria-label="Add transaction"
        >
          <IconPlus size={28} />
        </button>
      )}

      <nav className="tabbar">
        {NAV.map(([id, Icon, label]) => (
          <button
            key={id}
            className={page === id ? 'selected' : ''}
            onClick={() => go(id)}
            aria-current={page === id ? 'page' : undefined}
          >
            <span className="icon">
              <Icon size={22} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {modal && modal.kind === 'tx' && (
        <Overlay onClose={close}>
          <ModalHead title={modal.refundOf ? 'Add refund' : 'New transaction'} onClose={close} />
          <TxForm
            title={modal.refundOf ? 'Add refund' : 'New transaction'}
            refundOf={modal.refundOf}
            close={close}
          />
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
