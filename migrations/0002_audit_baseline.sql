-- Establish a truthful baseline for records that existed before audit tracking was exposed in the UI.
-- This does not invent prior edits: it records the state we know at the record's created_at time.

INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json, metadata_json)
SELECT lower(hex(randomblob(16))), created_at, 'account', id, 'create', NULL,
       json_object('id', id, 'name', name, 'opening_balance_minor', opening_balance_minor,
                   'opening_balance_at', opening_balance_at, 'is_active', is_active,
                   'created_at', created_at, 'updated_at', updated_at, 'deleted_at', deleted_at),
       '{"source":"baseline","note":"Existing record; prior changes before audit tracking are not available."}'
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='account' AND l.entity_id=a.id);

INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json, metadata_json)
SELECT lower(hex(randomblob(16))), created_at, 'category', id, 'create', NULL,
       json_object('id', id, 'name', name, 'parent_id', parent_id, 'kind', kind,
                   'sort_order', sort_order, 'is_active', is_active,
                   'created_at', created_at, 'updated_at', updated_at, 'deleted_at', deleted_at),
       '{"source":"baseline","note":"Existing record; prior changes before audit tracking are not available."}'
FROM categories c
WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='category' AND l.entity_id=c.id);

INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json, metadata_json)
SELECT lower(hex(randomblob(16))), created_at, 'payment_method', id, 'create', NULL,
       json_object('id', id, 'name', name, 'account_id', account_id, 'is_active', is_active,
                   'created_at', created_at, 'updated_at', updated_at, 'deleted_at', deleted_at),
       '{"source":"baseline","note":"Existing record; prior changes before audit tracking are not available."}'
FROM payment_methods p
WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='payment_method' AND l.entity_id=p.id);

INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json, metadata_json)
SELECT lower(hex(randomblob(16))), created_at, 'transaction', id, 'create', NULL,
       json_object('id', id, 'account_id', account_id, 'payment_method_id', payment_method_id,
                   'category_id', category_id, 'payee_id', payee_id, 'transaction_type', transaction_type,
                   'amount_minor', amount_minor, 'occurred_at', occurred_at, 'description', description,
                   'note', note, 'status', status, 'parent_transaction_id', parent_transaction_id,
                   'recurring_rule_id', recurring_rule_id, 'transfer_id', transfer_id,
                   'is_split_parent', is_split_parent, 'created_at', created_at,
                   'updated_at', updated_at, 'deleted_at', deleted_at),
       '{"source":"baseline","note":"Existing record; prior changes before audit tracking are not available."}'
FROM transactions t
WHERE NOT EXISTS (SELECT 1 FROM audit_log l WHERE l.entity_type='transaction' AND l.entity_id=t.id);

CREATE INDEX IF NOT EXISTS idx_audit_entity_time ON audit_log(entity_type, entity_id, occurred_at DESC);
