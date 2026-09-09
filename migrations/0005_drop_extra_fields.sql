-- Remove fields the user explicitly does not want on transactions:
-- reference number, tax, quantity, unit.
ALTER TABLE transactions DROP COLUMN reference_number;
ALTER TABLE transactions DROP COLUMN tax_minor;
ALTER TABLE transactions DROP COLUMN quantity;
ALTER TABLE transactions DROP COLUMN unit;
