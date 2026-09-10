-- One-time reconciliation of description_suggestions against live data.
--
-- touchDescriptionSuggestion() only ever incremented usage_count (on
-- create/update/CSV import); nothing ever decremented it when a
-- transaction's description was edited away from, or the transaction was
-- deleted. That let a description keep showing up in the autocomplete
-- suggestion list forever, even once no live transaction used it anymore
-- (e.g. renaming the one transaction that said "Gold coin 3gm" away from
-- that text left the suggestion behind indefinitely).
--
-- This migration rebuilds description_suggestions from scratch based on
-- what live (non-deleted) transactions actually use today. Going forward,
-- the worker also calls untouchDescriptionSuggestion() on edit/delete so
-- this drift shouldn't reaccumulate.
DELETE FROM description_suggestions;

INSERT INTO description_suggestions (id, description, usage_count, last_used_at, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  (
    SELECT t2.description FROM transactions t2
    WHERE t2.deleted_at IS NULL AND lower(t2.description) = lower(t.description)
    ORDER BY t2.occurred_at DESC LIMIT 1
  ) AS description,
  COUNT(*) AS usage_count,
  MAX(t.occurred_at) AS last_used_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
FROM transactions t
WHERE t.deleted_at IS NULL AND t.description IS NOT NULL AND trim(t.description) <> ''
GROUP BY lower(t.description);
