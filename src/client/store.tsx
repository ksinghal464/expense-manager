import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type {
  Account,
  Category,
  PaymentMethod,
  Payee,
  Tag,
  Bootstrap,
  Dashboard,
  TxView,
} from '../shared/types';

export type Page = 'dashboard' | 'activity' | 'recurring' | 'manage';

export type ActivityFilter = {
  type?: 'expense' | 'income';
  accountId?: string;
  categoryId?: string | null;
  from?: string;
  to?: string | null;
  label?: string;
};

export type Modal =
  | { kind: 'tx' }
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
  accounts: Account[];
  categories: Category[];
  methods: PaymentMethod[];
  payees: Payee[];
  tags: Tag[];
  suggestions: string[];
  transactions: TxView[];
  dash: Dashboard | null;
  page: Page;
  modal: Modal;
  go: (p: Page) => void;
  openActivity: (filter: ActivityFilter) => void;
  pendingActivityFilter: ActivityFilter | null;
  clearActivityFilter: () => void;
  open: (m: Modal) => void;
  close: () => void;
  refresh: () => Promise<void>;
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

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [pendingActivityFilter, setPendingActivityFilter] = useState<ActivityFilter | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [notify, setNotify] = useState('');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [transactions, setTransactions] = useState<TxView[]>([]);
  const [dash, setDash] = useState<Dashboard | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, d, t] = await Promise.all([
        api.bootstrap(),
        api.dashboard(),
        api.transactions({ limit: '500' }),
      ]);
      const src: Bootstrap = b || EMPTY;
      setAccounts(src.accounts || []);
      setCategories(src.categories || []);
      setMethods(src.paymentMethods || []);
      setPayees(src.payees || []);
      setTags(src.tags || []);
      setSuggestions(src.suggestions || []);
      setTransactions(t || []);
      setDash(d);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toast = useCallback((msg: string) => {
    setNotify(msg);
    window.setTimeout(() => setNotify((cur) => (cur === msg ? '' : cur)), 2600);
  }, []);

  const openActivity = useCallback((filter: ActivityFilter) => {
    setPendingActivityFilter(filter);
    setModal(null);
    setPage('activity');
  }, []);
  const clearActivityFilter = useCallback(() => setPendingActivityFilter(null), []);

  const value = useMemo<Store>(
    () => ({
      loading,
      error,
      accounts,
      categories,
      methods,
      payees,
      tags,
      suggestions,
      transactions,
      dash,
      page,
      modal,
      go: setPage,
      openActivity,
      pendingActivityFilter,
      clearActivityFilter,
      open: setModal,
      close: () => setModal(null),
      refresh,
      toast,
      notify,
    }),
    [
      loading,
      error,
      accounts,
      categories,
      methods,
      payees,
      tags,
      suggestions,
      transactions,
      dash,
      page,
      modal,
      openActivity,
      pendingActivityFilter,
      clearActivityFilter,
      refresh,
      toast,
      notify,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
