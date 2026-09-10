# Expense Manager — Data Model

## Principles

- IDs are stable UUIDs; display names are never used as transaction identity.
- Amounts are stored as integer minor units (paise for INR), never floating point.
- All user-visible master-data changes are audited.
- Deletion is soft deletion for user data; audit records are append-only.
- Cleared/uncleared is informational and never changes balances.
- Splits are first-class entries linked to one parent transaction.

## Entities

### accounts

`id`, `name`, `opening_balance_minor`, `opening_balance_at`, `is_active`, `created_at`, `updated_at`, `deleted_at`

### payment_methods

`id`, `account_id`, `name`, `is_active`, `created_at`, `updated_at`, `deleted_at`

A payment method belongs to an account.

### categories

`id`, `name`, `parent_id`, `kind`, `sort_order`, `is_active`, timestamps, `deleted_at`

`parent_id` is null for top-level categories. `kind` is expense/income/both.

### payees

`id`, `name`, `is_active`, timestamps, `deleted_at`

### transactions

`id`, `account_id`, `payment_method_id`, `category_id`, `payee_id`, `transaction_type`, `amount_minor`, `occurred_at`, `description`, `note`, `status`, `parent_transaction_id`, `recurring_rule_id`, `transfer_id`, `is_split_parent`, timestamps, `deleted_at`

`transaction_type`: expense/income.
`status`: cleared/uncleared.

### transaction_splits

Each split has its own category, amount, description and note and points to the parent transaction.

`id`, `transaction_id`, `category_id`, `amount_minor`, `description`, `note`, timestamps, `deleted_at`

For a split parent, the sum of active split amounts must equal the parent amount.

### transfers

`id`, `from_account_id`, `to_account_id`, `amount_minor`, `occurred_at`, `description`, `note`, timestamps, `deleted_at`

A transfer creates two linked account-side entries but is not income or expense.

### recurring_rules

`id`, `name`, `transaction_type`, `account_id`, `payment_method_id`, `category_id`, `payee_id`, `amount_minor`, `description`, `note`, `frequency`, `interval_value`, `next_due_at`, `is_active`, timestamps, `deleted_at`

Due rules are materialized into transactions on the due date, idempotently.

### audit_log

Append-only.

`id`, `occurred_at`, `entity_type`, `entity_id`, `action`, `before_json`, `after_json`, `metadata_json`

Actions include create/update/delete/restore and configuration changes. A transaction edit records before and after snapshots.

### description_suggestions

Stores normalized descriptions used to power autocomplete. Notes are intentionally excluded.

`id`, `description`, `usage_count`, `last_used_at`, timestamps

### attachments

`id`, `transaction_id`, `provider`, `external_file_id`, `file_name`, `mime_type`, `size_bytes`, timestamps, `deleted_at`

Receipt bytes live outside D1; D1 stores the reference.

## Balance rule

`balance = opening_balance + income - expense + transfers_in - transfers_out`

Cleared status has no effect.

Refunds are recorded as `income`-type transactions linking back to the
expense they credit via `refunds_transaction_id`; this keeps the true
account balance calculation above correct (a refund is real money back in
the account). Dashboard widgets, however, net refunds directly against the
`expense` total instead of surfacing them as `income`, so the expense
figure reflects the actual out-of-pocket amount and refunds are never
shown mixed in with real income (see `rangeStats`/`categoryBreakdown` in
`src/worker/aggregate.ts`).

## Rename rule

Transactions store foreign keys to master records. Renaming a category, account, payment method, or payee changes the master record only; existing transactions automatically display the new name. The rename itself is audited.
