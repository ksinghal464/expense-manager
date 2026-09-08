-- Evolution from the 0001 base schema to the modern model.
-- Non-destructive: adds columns/tables only, no data loss.

-- Accounts: currency per account.
ALTER TABLE accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'INR';

-- Payees: free-form address.
ALTER TABLE payees ADD COLUMN address TEXT NOT NULL DEFAULT '';

-- Transactions: optional detail fields (minimalist).
ALTER TABLE transactions ADD COLUMN reference_number TEXT NOT NULL DEFAULT '';
ALTER TABLE transactions ADD COLUMN tax_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN quantity REAL;
ALTER TABLE transactions ADD COLUMN unit TEXT NOT NULL DEFAULT '';
-- A refund is a separate income-type entry with its own date, linked to the
-- expense it credits. NULL for non-refunds.
ALTER TABLE transactions ADD COLUMN refunds_transaction_id TEXT REFERENCES transactions(id);

-- Recurring: optional installment count + idempotency marker.
ALTER TABLE recurring_rules ADD COLUMN no_of_payments INTEGER;
ALTER TABLE recurring_rules ADD COLUMN last_generated_at TEXT;

-- Tags (multi-tag on a transaction).
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (transaction_id, tag_id)
);

-- Notes: free-form, attachable to a transaction (or standalone), optional reminder.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id),
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  reminder_at TEXT,
  is_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Settings: simple key/value (date format, first day of week, currency, drive refs...).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Indexes + partial unique on tag name.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON transaction_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_notes_transaction ON notes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_notes_reminder ON notes(reminder_at);
CREATE INDEX IF NOT EXISTS idx_tx_refund ON transactions(refunds_transaction_id);
