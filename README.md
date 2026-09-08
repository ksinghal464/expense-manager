# Expense Manager

Personal, single-user expense manager.

## Planned architecture

- Frontend: React + TypeScript + Vite
- Backend: Cloudflare Workers
- Database: Cloudflare D1 (SQLite)
- Source control: GitHub
- Receipts/backups: Google Drive

## Core requirements

- Dashboard landing page
- Activity page with configurable date ranges and filters
- Expense and income transactions
- Accounts with opening balances and negative balances allowed
- Account-specific payment methods
- Custom categories and subcategories
- Payee/payer master data
- Split transactions with per-split category, description, and note
- Transfers between accounts
- Recurring transactions automatically generated on due date
- Cleared/uncleared status that does not affect balance
- Free-text descriptions with autocomplete; notes remain free-text without autocomplete
- Search across description, note, category, subcategory, account, payment method, and payee/payer
- Receipt attachments
- Soft deletion and restore
- Append-only audit log for transactions and configuration/master-data changes
- Renaming master data updates display names for existing transactions via stable IDs
- Import from the existing Expense Manager CSV export
- Backup/restore support

## Explicitly excluded

- Ref/check number
- Tags
- Unit
- Quantity
- Credit-card tracking
- Multiple currencies for v1
