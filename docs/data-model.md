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

A transfer moves money between two of the user's own accounts. It is the
source of truth for amount/date/description/note, and is paired with two
linked `transactions` rows sharing its id via `transaction_id.transfer_id`:
an `expense` leg on `from_account_id` and an `income` leg on
`to_account_id`, each optionally with its own payment method (validated to
belong to its account) but no category/payee — a transfer isn't
categorized. This makes true per-account balances work with no
special-casing (money leaves one account, arrives in the other, like any
other expense/income row), while
`rangeStats`/`categoryBreakdown`/`entityBreakdown` explicitly exclude
`transfer_id IS NOT NULL` rows so a transfer never shows up as income or
expense in any report/widget — it is not income or expense.

Created via `POST /api/transfers`, edited via `PUT /api/transfers/:id`
(amount/date/description/note/payment methods — the from/to accounts
themselves are fixed once created). Deleting/restoring/purging either
linked transaction cascades to its sibling leg and the `transfers` row, so
a transfer always appears or disappears as a single unit (see
`deleteTransaction`/`restoreTransaction`
in `src/worker/routes.ts`). A transfer's expense leg cannot be refunded.

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

`balance = opening_balance + income - expense` (per account, computed over
each account's own `expense`/`income`-type transactions, transfer legs
included — see `transfers` above for why that's correct).

Cleared status has no effect.

Refunds are recorded as `income`-type transactions linking back to the
expense they credit via `refunds_transaction_id`; this keeps the true
account balance calculation above correct (a refund is real money back in
the account). Everywhere else — dashboard widgets, category breakdowns,
and payment-method/payee breakdowns — refunds are netted directly against
the `expense` total instead of being counted as `income`, so expense
figures reflect the actual out-of-pocket amount and refunds never show up
mixed in with real income (see `rangeStats`, `categoryBreakdown`, and
`entityBreakdown` in `src/worker/aggregate.ts`).

Transfers follow the same "excluded from every report, but count fully for
the real per-account balance" pattern as refunds — see the `transfers`
section above.

## Rename rule

Transactions store foreign keys to master records. Renaming a category, account, payment method, or payee changes the master record only; existing transactions automatically display the new name. The rename itself is audited.
