-- Allow each split part of a transaction to carry its own date/time
-- (defaults to the parent transaction's date when not set explicitly).
ALTER TABLE transaction_splits ADD COLUMN occurred_at TEXT;
