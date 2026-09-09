-- Enforce recurring-transaction idempotency at the database level: two
-- concurrent "generate due" runs (the daily cron and/or a manual "Generate
-- now") can no longer insert two transactions for the same rule + due date.
-- The unique index only applies to live (non-deleted) recurring-generated
-- transactions, so soft-deleting one and regenerating is still possible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_occurrence
  ON transactions(recurring_rule_id, occurred_at)
  WHERE recurring_rule_id IS NOT NULL AND deleted_at IS NULL;
