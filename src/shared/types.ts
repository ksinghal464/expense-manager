export type TxType = 'expense' | 'income';
export type TxStatus = 'cleared' | 'uncleared';
export type CategoryKind = 'expense' | 'income' | 'both';

export interface Account {
  id: string;
  name: string;
  currency: string;
  opening_balance_minor: number;
  opening_balance_at: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  balance_minor?: number;
}

export interface PaymentMethod {
  id: string;
  account_id: string;
  name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  kind: CategoryKind;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Payee {
  id: string;
  name: string;
  address: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Tag {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TxRow {
  id: string;
  account_id: string;
  payment_method_id: string | null;
  category_id: string | null;
  payee_id: string | null;
  transaction_type: TxType;
  amount_minor: number;
  occurred_at: string;
  description: string;
  note: string;
  status: TxStatus;
  refunds_transaction_id: string | null;
  parent_transaction_id: string | null;
  recurring_rule_id: string | null;
  is_split_parent: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TxView extends TxRow {
  account_name: string;
  category_name: string | null;
  payee_name: string | null;
  payment_method_name: string | null;
  refund_of_description?: string | null;
  refund_of_occurred_at?: string | null;
  tags?: string[];
  splits?: SplitRow[];
  refunds?: TxView[];
  refunded_minor?: number;
  net_minor?: number;
}

export interface SplitRow {
  id: string;
  transaction_id: string;
  category_id: string | null;
  amount_minor: number;
  description: string;
  note: string;
  occurred_at: string | null;
  category_name?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Attachment {
  id: string;
  transaction_id: string;
  kind: 'image' | 'link';
  url: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RecurringRule {
  id: string;
  name: string;
  transaction_type: TxType;
  account_id: string;
  payment_method_id: string | null;
  category_id: string | null;
  payee_id: string | null;
  amount_minor: number;
  description: string;
  note: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval_value: number;
  no_of_payments: number | null;
  next_due_at: string;
  is_active: number;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AuditEntry {
  id: string;
  occurred_at: string;
  entity_type: string;
  entity_id: string;
  action: string;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
}

export interface Bootstrap {
  accounts: Account[];
  categories: Category[];
  paymentMethods: PaymentMethod[];
  payees: Payee[];
  tags: Tag[];
  suggestions: string[];
  recurring: RecurringRule[];
}

export interface DashboardFrame {
  key: string;
  label: string;
  from: string;
  to: string | null;
  income: number;
  expense: number;
  refunded: number;
}

export interface CategoryTotal {
  id: string | null;
  name: string;
  total: number;
}

export interface Dashboard {
  frames: DashboardFrame[];
  categories: CategoryTotal[];
  balances: Account[];
}

export interface ImportSummary {
  inserted: number;
  accounts: number;
  categories: number;
  payees: number;
  methods: number;
  errors: { line: number; message: string }[];
}
