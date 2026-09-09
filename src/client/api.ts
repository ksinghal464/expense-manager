import type {
  Account,
  Category,
  PaymentMethod,
  Payee,
  Tag,
  TxView,
  Bootstrap,
  Dashboard,
  ImportSummary,
  RecurringRule,
  AuditEntry,
} from '../shared/types';

export type SplitRow = {
  id: string;
  category_id: string | null;
  category_name?: string | null;
  amount_minor: number;
  description: string;
  note: string;
};
export type AttachmentRow = {
  id: string;
  transaction_id: string;
  provider: string;
  external_file_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  kind: string;
  url: string;
};
export type TxDetail = TxView & {
  splits: SplitRow[];
  refunds: TxView[];
  tags: string[];
  refunded_minor: number;
};
export type SearchOptions = {
  descriptions: { value: string; count: number }[];
  categories: { id: string; name: string; kind: string; parent_id: string | null }[];
  methods: { id: string; name: string; account_id: string }[];
  accounts: { id: string; name: string }[];
  payees: { id: string; name: string }[];
  tags: { id: string; name: string }[];
};
export type Generated = { created: number; skipped: number; deactivated: number };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string })?.error || r.statusText);
  return data as T;
}

const J = { 'content-type': 'application/json' } as const;
const post = <T = unknown>(path: string, body: unknown): Promise<T> =>
  req<T>(path, { method: 'POST', headers: J, body: JSON.stringify(body) });
const put = <T = unknown>(path: string, body: unknown): Promise<T> =>
  req<T>(path, { method: 'PUT', headers: J, body: JSON.stringify(body) });

export const api = {
  health: () => req<{ ok: boolean }>('/api/health'),
  bootstrap: () => req<Bootstrap>('/api/bootstrap'),
  dashboard: () => req<Dashboard>('/api/dashboard'),
  dashboardFrame: (from: string, to?: string | null, accountId?: string | null) =>
    req<{ income: number; expense: number; refunded: number }>(
      `/api/dashboard/frame?${new URLSearchParams({
        from,
        ...(to ? { to } : {}),
        ...(accountId ? { accountId } : {}),
      })}`
    ),
  dashboardCategories: (
    from: string,
    to?: string | null,
    accountId?: string | null,
    type?: 'expense' | 'income'
  ) =>
    req<{ id: string | null; name: string; total: number }[]>(
      `/api/dashboard/categories?${new URLSearchParams({
        from,
        ...(to ? { to } : {}),
        ...(accountId ? { accountId } : {}),
        ...(type ? { type } : {}),
      })}`
    ),
  searchOptions: (q: string) =>
    req<SearchOptions>(`/api/search-options?q=${encodeURIComponent(q)}`),

  transactions: (qs?: Record<string, string>) => {
    const p = qs ? `?${new URLSearchParams(qs)}` : '';
    return req<TxView[]>(`/api/transactions${p}`);
  },
  transaction: (id: string) => req<TxDetail>(`/api/transactions/${id}`),
  transactionAudit: (id: string) => req<AuditEntry[]>(`/api/transactions/${id}/audit`),
  createTransaction: (body: Record<string, unknown>) =>
    req<TxDetail>('/api/transactions', { method: 'POST', headers: J, body: JSON.stringify(body) }),
  updateTransaction: (id: string, body: Record<string, unknown>) =>
    req<TxDetail>(`/api/transactions/${id}`, {
      method: 'PUT',
      headers: J,
      body: JSON.stringify(body),
    }),
  deleteTransaction: (id: string, hard = false) =>
    req<{ ok: boolean }>(`/api/transactions/${id}${hard ? '?hard=1' : ''}`, { method: 'DELETE' }),
  restoreTransaction: (id: string) => post(`/api/transactions/${id}/restore`, {}),
  purgeTransaction: (id: string) => post(`/api/transactions/${id}/purge`, {}),
  trash: () => req<TxView[]>('/api/trash'),
  purgeTrash: () => post('/api/trash/purge', {}),

  accounts: () => req<Account[]>('/api/accounts'),
  saveAccount: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/accounts/${id}`, body) : post('/api/accounts', body),
  deleteAccount: (id: string) => req(`/api/accounts/${id}`, { method: 'DELETE' }),

  categories: () => req<Category[]>('/api/categories'),
  saveCategory: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/categories/${id}`, body) : post('/api/categories', body),
  deleteCategory: (id: string) => req(`/api/categories/${id}`, { method: 'DELETE' }),

  paymentMethods: () => req<PaymentMethod[]>('/api/payment-methods'),
  savePaymentMethod: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/payment-methods/${id}`, body) : post('/api/payment-methods', body),
  deletePaymentMethod: (id: string) => req(`/api/payment-methods/${id}`, { method: 'DELETE' }),

  payees: () => req<Payee[]>('/api/payees'),
  savePayee: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/payees/${id}`, body) : post('/api/payees', body),
  deletePayee: (id: string) => req(`/api/payees/${id}`, { method: 'DELETE' }),

  tags: () => req<Tag[]>('/api/tags'),
  saveTag: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/tags/${id}`, body) : post('/api/tags', body),
  deleteTag: (id: string) => req(`/api/tags/${id}`, { method: 'DELETE' }),

  attachments: (transactionId?: string) => {
    const p = transactionId ? `?transactionId=${encodeURIComponent(transactionId)}` : '';
    return req<AttachmentRow[]>(`/api/attachments${p}`);
  },
  createAttachment: (body: Record<string, unknown>) => post('/api/attachments', body),
  deleteAttachment: (id: string) => req(`/api/attachments/${id}`, { method: 'DELETE' }),

  recurring: () => req<RecurringRule[]>('/api/recurring'),
  saveRecurring: (id: string | null, body: Record<string, unknown>) =>
    id ? put(`/api/recurring/${id}`, body) : post('/api/recurring', body),
  deleteRecurring: (id: string) => req(`/api/recurring/${id}`, { method: 'DELETE' }),
  generateRecurring: (id: string) => post(`/api/recurring/${id}/generate`, {}),
  skipRecurring: (id: string) => post(`/api/recurring/${id}/skip`, {}),
  toggleRecurring: (id: string) =>
    req<RecurringRule>(`/api/recurring/${id}/toggle`, { method: 'PATCH' }),
  runRecurring: () => req<Generated>('/api/recurring/run'),

  importCsv: (csv: string, mode: 'append' | 'replace') =>
    post<ImportSummary>(`/api/import/csv?mode=${mode}`, { csv }),
  exportCsv: (qs?: Record<string, string>) => {
    const p = qs ? `?${new URLSearchParams(qs)}` : '';
    return fetch(`/api/export/csv${p}`).then((r) => {
      if (!r.ok)
        return r.text().then((t) => {
          throw new ApiError(r.status, t);
        });
      return r.text();
    });
  },
  exportJson: () => req<unknown>('/api/export/json'),
  restoreBackup: (backup: unknown) => post<{ restored: number }>('/api/import/backup', backup),
  driveStatus: () =>
    req<{
      configured: boolean;
      connected: boolean;
      lastBackupAt: string | null;
      autoBackup: boolean;
    }>('/api/drive/status'),
  driveBackup: () =>
    post<{ ok: boolean; fileId: string; backedUpAt: string }>('/api/drive/backup', {}),
  driveRestore: () => post<{ restored: number }>('/api/drive/restore', {}),
  driveDisconnect: () => post<{ ok: boolean }>('/api/drive/disconnect', {}),
  driveSetAutoBackup: (enabled: boolean) =>
    post<{ ok: boolean }>('/api/drive/auto-backup', { enabled }),

  audit: (qs?: Record<string, string>) => {
    const p = qs ? `?${new URLSearchParams(qs)}` : '';
    return req<AuditEntry[]>(`/api/audit${p}`);
  },
};

export type { ImportSummary };
