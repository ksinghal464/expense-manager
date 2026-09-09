import { money } from './lib';
import { fmtDateTime, parseJson } from './lib';
import type { Account, Category, Payee, PaymentMethod } from '../shared/types';

/** Friendly labels for raw DB field names shown in audit entries. */
const FIELD_LABELS: Record<string, string> = {
  amount_minor: 'Amount',
  tax_minor: 'Tax',
  transaction_type: 'Type',
  occurred_at: 'Date & time',
  account_id: 'Account',
  category_id: 'Category',
  payment_method_id: 'Payment method',
  payee_id: 'Payee / payer',
  refunds_transaction_id: 'Refund of',
  is_split_parent: 'Split transaction',
  is_active: 'Active',
  opening_balance_minor: 'Opening balance',
  opening_balance_at: 'Opening balance date',
  parent_id: 'Parent category',
  kind: 'Type',
  frequency: 'Frequency',
  interval_value: 'Every',
  no_of_payments: 'Number of payments',
  next_due_at: 'Next due',
  last_generated_at: 'Last generated',
  reminder_at: 'Reminder',
  is_done: 'Done',
};

/** Fields never shown in a diff — internal bookkeeping only. */
const HIDDEN_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'sort_order',
  'parent_transaction_id',
  'recurring_rule_id',
]);

/** Fields whose raw value is a money amount stored in minor units. */
const MONEY_FIELDS = new Set(['amount_minor', 'tax_minor', 'opening_balance_minor']);

/** Fields whose raw value is an ISO date/time. */
const DATE_FIELDS = new Set([
  'occurred_at',
  'opening_balance_at',
  'next_due_at',
  'last_generated_at',
  'reminder_at',
]);

/** Fields that reference another entity by id and should be resolved to a name. */
const REF_FIELDS: Record<string, 'account' | 'category' | 'method' | 'payee'> = {
  account_id: 'account',
  category_id: 'category',
  payment_method_id: 'method',
  payee_id: 'payee',
};

const BOOL_FIELDS = new Set(['is_active', 'is_split_parent', 'is_done']);

export interface Lookups {
  accounts: Account[];
  categories: Category[];
  methods: PaymentMethod[];
  payees: Payee[];
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] || key.replace(/_id$/, '').replace(/_/g, ' ');
}

function resolveRef(
  kind: 'account' | 'category' | 'method' | 'payee',
  id: string,
  l: Lookups
): string | null {
  if (kind === 'account') return l.accounts.find((a) => a.id === id)?.name ?? null;
  if (kind === 'category') return l.categories.find((c) => c.id === id)?.name ?? null;
  if (kind === 'method') return l.methods.find((m) => m.id === id)?.name ?? null;
  if (kind === 'payee') return l.payees.find((p) => p.id === id)?.name ?? null;
  return null;
}

function formatValue(key: string, value: unknown, l: Lookups): string {
  if (value == null || value === '') return '—';
  if (MONEY_FIELDS.has(key)) return money(Number(value));
  if (DATE_FIELDS.has(key)) return fmtDateTime(String(value));
  if (key === 'transaction_type') return value === 'income' ? 'Income' : 'Expense';
  if (key === 'status') return value === 'uncleared' ? 'Uncleared' : 'Cleared';
  if (key === 'kind')
    return value === 'both'
      ? 'Expense & income'
      : String(value) === 'income'
        ? 'Income'
        : 'Expense';
  if (BOOL_FIELDS.has(key)) return Number(value) ? 'Yes' : 'No';
  if (key === 'frequency') return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  const ref = REF_FIELDS[key];
  if (ref) {
    const name = resolveRef(ref, String(value), l);
    if (name) return name;
  }
  return String(value);
}

/** Human-readable, resolved-name before/after diff for an 'update' audit entry. */
export function AuditDiff({
  before,
  after,
  lookups,
}: {
  before: string | null;
  after: string | null;
  lookups: Lookups;
}) {
  const b = parseJson(before) || {};
  const a = parseJson(after) || {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter(
    (k) => !HIDDEN_FIELDS.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k])
  );
  if (!keys.length) return <div className="auditcreated">Record updated.</div>;
  return (
    <div className="auditdiff">
      {keys.slice(0, 12).map((k) => (
        <div key={k}>
          <span>{fieldLabel(k)}</span>
          <del>{formatValue(k, b[k], lookups)}</del>
          <b>→</b>
          <strong>{formatValue(k, a[k], lookups)}</strong>
        </div>
      ))}
    </div>
  );
}

/** Compact "what was recorded" summary for a 'create' audit entry. */
export function AuditSnapshot({ json, lookups }: { json: string | null; lookups: Lookups }) {
  const row = parseJson(json) || {};
  const keys = Object.keys(row).filter(
    (k) => !HIDDEN_FIELDS.has(k) && row[k] != null && row[k] !== ''
  );
  if (!keys.length) return null;
  return (
    <div className="auditdiff">
      {keys.slice(0, 12).map((k) => (
        <div key={k}>
          <span>{fieldLabel(k)}</span>
          <strong>{formatValue(k, row[k], lookups)}</strong>
        </div>
      ))}
    </div>
  );
}

/** Renders the appropriate body for any audit action (create/update/delete/restore). */
export function AuditBody({
  action,
  before,
  after,
  lookups,
}: {
  action: string;
  before: string | null;
  after: string | null;
  lookups: Lookups;
}) {
  if (action === 'update') return <AuditDiff before={before} after={after} lookups={lookups} />;
  if (action === 'create') return <AuditSnapshot json={after} lookups={lookups} />;
  if (action === 'delete' || action === 'restore')
    return <AuditSnapshot json={before || after} lookups={lookups} />;
  return null;
}
