import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, ApiError } from './api';
import { mergeChanges, type TxChanges } from './txMerge';
import {
  parseRoute,
  routeUrl,
  pageRoute,
  type ActivityFilter,
  type ActivityState,
  type ManageTab,
  type Page,
  type Route,
} from './route';
import type {
  Account,
  Category,
  PaymentMethod,
  Payee,
  Tag,
  Bootstrap,
  TxView,
} from '../shared/types';

export type { ActivityFilter, ActivityState, ManageTab, Page, Route };

export type Modal =
  | { kind: 'tx'; refundOf?: string }
  | { kind: 'editTx'; id: string }
  | { kind: 'detail'; id: string; fromTrash?: boolean }
  | { kind: 'account'; item?: Account }
  | { kind: 'category'; item?: Category }
  | { kind: 'method'; item?: PaymentMethod }
  | { kind: 'payee'; item?: Payee }
  | { kind: 'tag'; item?: Tag }
  | { kind: 'import' }
  | { kind: 'audit' }
  | null;

export interface Store {
  loading: boolean;
  error: string;
  needsLogin: boolean;
  accounts: Account[];
  categories: Category[];
  methods: PaymentMethod[];
  payees: Payee[];
  tags: Tag[];
  suggestions: string[];
  transactions: TxView[];
  /** Current location, mirrored in the browser URL. */
  route: Route;
  page: Page;
  modal: Modal;
  /** Switch to a page (new history entry). No-op when already there. */
  go: (p: Page) => void;
  /** Show Activity with the given filter (new history entry). */
  openActivity: (filter: ActivityFilter) => void;
  /** Patch the Activity filter/search/page in place (replaces the history entry). */
  setActivity: (patch: Partial<ActivityState>) => void;
  setManageTab: (tab: ManageTab) => void;
  open: (m: Modal) => void;
  close: () => void;
  /** Full reload of master data and every transaction. */
  refresh: () => Promise<void>;
  /**
   * Apply a save's result to the in-memory list instead of reloading everything.
   * Pass the saved description so a new one shows up in autocomplete.
   */
  applyChanges: (changes: TxChanges, description?: string) => void;
  toast: (msg: string) => void;
  notify: string;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside <StoreProvider>');
  return s;
}

const EMPTY: Bootstrap = {
  accounts: [],
  categories: [],
  paymentMethods: [],
  payees: [],
  tags: [],
  suggestions: [],
  recurring: [],
};

const PAGE_SIZE = 500;
const MAX_PAGES = 40; // hard safety cap (~20k transactions) against unbounded fetch loops

/**
 * Fetch every transaction by paging through the server's limit/offset API
 * instead of relying on a single capped request. Previously the app only
 * ever loaded the newest 500 transactions, silently hiding older ones from
 * search, filters, running balances, and dashboards once that cap was
 * exceeded.
 */
async function fetchAllTransactions(): Promise<TxView[]> {
  const all: TxView[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await api.transactions({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

// ---- browser history ----
// The page, Activity filters, Manage tab and an open transaction detail live
// in the URL, so reloads and the back button keep your place. Other modals
// (forms, master-data dialogs) aren't in the URL, but opening one pushes a
// same-URL entry marked `k: 'modal'` so the back button closes it.
type HistState = { k?: 'modal' | 'detail' } | null;

function currentRoute(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}
function currentKind(): 'modal' | 'detail' | undefined {
  return (window.history.state as HistState)?.k;
}

// A reload can't restore a non-URL modal, so step back off its history entry once.
let droppedStaleModalEntry = false;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [route, setRoute] = useState<Route>(currentRoute);
  // Non-URL modal shown on top of the page (and on top of any detail in the URL).
  const [overlay, setOverlay] = useState<Modal>(null);
  const [notify, setNotify] = useState('');

  // history.back() is async; anything navigating meanwhile waits for its popstate,
  // otherwise e.g. close() followed by open() would push and then pop the new entry.
  const backPending = useRef(false);
  const queued = useRef<(() => void)[]>([]);
  const whenSettled = useCallback((fn: () => void) => {
    if (backPending.current) queued.current.push(fn);
    else fn();
  }, []);
  const back = useCallback(() => {
    backPending.current = true;
    window.history.back();
  }, []);

  useEffect(() => {
    const onPop = () => {
      backPending.current = false;
      setRoute(currentRoute());
      if (currentKind() !== 'modal') setOverlay(null);
      const q = queued.current;
      queued.current = [];
      q.forEach((fn) => fn());
    };
    window.addEventListener('popstate', onPop);
    if (!droppedStaleModalEntry && currentKind() === 'modal') {
      droppedStaleModalEntry = true;
      back();
    }
    return () => window.removeEventListener('popstate', onPop);
  }, [back]);

  const navigate = useCallback(
    (update: (r: Route) => Route, mode: 'push' | 'replace', kind?: 'detail') =>
      whenSettled(() => {
        const cur = currentRoute();
        const next = update(cur);
        const url = routeUrl(next);
        if (mode === 'replace') {
          window.history.replaceState(window.history.state, '', url);
        } else {
          if (url === window.location.pathname + window.location.search) return;
          window.history.pushState(kind ? { k: kind } : null, '', url);
          if (next.page !== cur.page) window.scrollTo(0, 0);
        }
        setRoute(currentRoute());
      }),
    [whenSettled]
  );

  const close = useCallback(
    () =>
      whenSettled(() => {
        const k = currentKind();
        if (k === 'modal' || k === 'detail') {
          back();
          return;
        }
        // Opened by a reload or a pasted link: nothing of ours to go back to.
        setOverlay(null);
        if (currentRoute().tx)
          navigate((r) => ({ ...r, tx: undefined, trash: undefined }), 'replace');
      }),
    [whenSettled, back, navigate]
  );

  const open = useCallback(
    (m: Modal) => {
      if (!m) return close();
      if (m.kind === 'detail') {
        whenSettled(() => setOverlay(null));
        navigate((r) => ({ ...r, tx: m.id, trash: m.fromTrash || undefined }), 'push', 'detail');
        return;
      }
      whenSettled(() => {
        if (currentKind() !== 'modal') {
          window.history.pushState(
            { k: 'modal' },
            '',
            window.location.pathname + window.location.search
          );
        }
        setOverlay(m);
      });
    },
    [close, navigate, whenSettled]
  );

  // Leaving the page while a form is open: drop the form's history entry too,
  // otherwise Back would later land on it with nothing left to show.
  const dropOverlay = useCallback(
    () =>
      whenSettled(() => {
        setOverlay(null);
        if (currentKind() === 'modal') back();
      }),
    [whenSettled, back]
  );

  const go = useCallback(
    (page: Page) => {
      dropOverlay();
      navigate((r) => (r.page === page ? r : pageRoute(page)), 'push');
    },
    [navigate, dropOverlay]
  );

  const openActivity = useCallback(
    (filter: ActivityFilter) => {
      dropOverlay();
      navigate(() => pageRoute('activity', filter), 'push');
    },
    [navigate, dropOverlay]
  );

  const setActivity = useCallback(
    (patch: Partial<ActivityState>) =>
      navigate(
        (r) => (r.page === 'activity' ? { ...r, activity: { ...r.activity, ...patch } } : r),
        'replace'
      ),
    [navigate]
  );

  const setManageTab = useCallback(
    (tab: ManageTab) => navigate((r) => ({ ...r, page: 'manage', tab }), 'push'),
    [navigate]
  );

  const modal = useMemo<Modal>(
    () => overlay ?? (route.tx ? { kind: 'detail', id: route.tx, fromTrash: route.trash } : null),
    [overlay, route.tx, route.trash]
  );

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<TxView[]>([]);

  const applyBootstrap = useCallback((b: Bootstrap | null) => {
    const src: Bootstrap = b || EMPTY;
    setAccounts(src.accounts || []);
    setCategories(src.categories || []);
    setMethods(src.paymentMethods || []);
    setPayees(src.payees || []);
    setTags(src.tags || []);
    setSuggestions(src.suggestions || []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [b, t] = await Promise.all([api.bootstrap(), fetchAllTransactions()]);
      applyBootstrap(b);
      setTransactions(t || []);
      setError('');
      setNeedsLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsLogin(true);
        setError('');
      } else {
        // fetch() network failures: Chrome "Failed to fetch", Safari "Load failed",
        // Firefox "NetworkError when attempting to fetch resource."
        const offline =
          !navigator.onLine ||
          (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
        setError(
          offline
            ? "Can't reach the server. Check your connection, then retry."
            : e instanceof Error
              ? e.message
              : 'Unable to load data'
        );
      }
    } finally {
      setLoading(false);
    }
  }, [applyBootstrap]);

  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;
  const applyChanges = useCallback(
    (c: TxChanges, description?: string) => {
      setTransactions((prev) => mergeChanges(prev, c.affected || [], c.removed || []));
      const d = description?.trim().toLowerCase();
      const newSuggestion = !!d && !suggestionsRef.current.some((x) => x.toLowerCase() === d);
      // New payee/tag/description: reload just the master data lists, in the background.
      if (c.masterChanged || newSuggestion)
        api
          .bootstrap()
          .then(applyBootstrap)
          .catch(() => {});
    },
    [applyBootstrap]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toast = useCallback((msg: string) => {
    setNotify(msg);
    window.setTimeout(() => setNotify((cur) => (cur === msg ? '' : cur)), 2600);
  }, []);

  const value = useMemo<Store>(
    () => ({
      loading,
      error,
      needsLogin,
      accounts,
      categories,
      methods,
      payees,
      tags,
      suggestions,
      transactions,
      route,
      page: route.page,
      modal,
      go,
      openActivity,
      setActivity,
      setManageTab,
      open,
      close,
      refresh,
      applyChanges,
      toast,
      notify,
    }),
    [
      loading,
      error,
      needsLogin,
      accounts,
      categories,
      methods,
      payees,
      tags,
      suggestions,
      transactions,
      route,
      modal,
      go,
      openActivity,
      setActivity,
      setManageTab,
      open,
      close,
      refresh,
      applyChanges,
      toast,
      notify,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
