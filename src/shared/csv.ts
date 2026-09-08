import { toMinor } from './money';

/**
 * Legacy CSV import. The Android app exported rows with this header:
 * Date,Amount,Category,Subcategory,Payment Method,Description,Ref/Check No,
 * Payee/Payer,Status,Receipt Picture,Account,Tag,Tax,Quantity,Unit,Split Total,
 * Row Id,Type Id
 *
 * Sign convention (export): negative = expense/outflow, positive = income,
 * and a positive non-Income row inside a "Split Total" group = a refund.
 */
export interface RawImportRow {
  date: string;
  amount: string;
  category: string;
  subcategory: string;
  payment_method: string;
  description: string;
  reference_number: string;
  payee: string;
  status: string;
  receipt: string;
  account: string;
  tag: string;
  tax: string;
  quantity: string;
  unit: string;
  split_total: string;
  row_id: string;
  type_id: string;
  line: number;
}

export interface NormImportRow extends RawImportRow {
  type: 'expense' | 'income';
  amount_minor: number;
  is_refund: boolean;
  group: string | null;
}

export interface ImportGroup {
  group: string | null;
  rows: NormImportRow[];
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/quotes/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') pushRow();
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const COL: Record<string, keyof RawImportRow> = {
  Date: 'date',
  Amount: 'amount',
  Category: 'category',
  Subcategory: 'subcategory',
  'Payment Method': 'payment_method',
  Description: 'description',
  'Ref/Check No': 'reference_number',
  'Payee/Payer': 'payee',
  Status: 'status',
  'Receipt Picture': 'receipt',
  Account: 'account',
  Tag: 'tag',
  Tax: 'tax',
  Quantity: 'quantity',
  Unit: 'unit',
  'Split Total': 'split_total',
  'Row Id': 'row_id',
  'Type Id': 'type_id',
};

export interface ParsedImport {
  rows: RawImportRow[];
  errors: { line: number; message: string }[];
}

/** Locate the header, map columns by name, and return typed raw rows. */
export function parseImportCsv(text: string): ParsedImport {
  const clean = text.replace(/^\uFEFF/, '');
  const grid = parseCsv(clean);
  const errors: { line: number; message: string }[] = [];
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    if (grid[i].includes('Date') && grid[i].includes('Amount')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      rows: [],
      errors: [{ line: 1, message: 'No header row with "Date" and "Amount" columns found.' }],
    };
  }
  const header = grid[headerIdx].map((h) => h.trim());
  const colIndex: Partial<Record<keyof RawImportRow, number>> = {};
  for (const [name, key] of Object.entries(COL)) {
    const idx = header.indexOf(name);
    if (idx !== -1) colIndex[key] = idx;
  }
  for (const req of ['date', 'amount', 'category', 'account'] as (keyof RawImportRow)[]) {
    if (colIndex[req] === undefined) {
      errors.push({ line: headerIdx + 1, message: `Missing required column for "${req}".` });
    }
  }
  const rows: RawImportRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const g = grid[i];
    const raw = {} as RawImportRow;
    raw.line = i + 1;
    for (const key of Object.keys(colIndex) as (keyof RawImportRow)[]) {
      const idx = colIndex[key] as number;
      (raw as unknown as Record<string, string>)[key] = (g[idx] ?? '').trim();
    }
    if (!raw.date && !raw.amount) continue;
    rows.push(raw);
  }
  return { rows, errors };
}

/** Determine type/magnitude/refund-ness for each raw row (pure, no DB). */
export function normalizeRows(raws: RawImportRow[]): NormImportRow[] {
  return raws.map((raw) => {
    const amt = parseFloat(raw.amount);
    const isIncomeCat = raw.category.trim().toLowerCase() === 'income';
    let type: 'expense' | 'income';
    let is_refund = false;
    let amount_minor = 0;
    if (amt < 0) {
      type = 'expense';
      amount_minor = toMinor(-amt);
    } else if (amt > 0) {
      type = 'income';
      amount_minor = toMinor(amt);
      is_refund = !isIncomeCat;
    } else {
      type = isIncomeCat ? 'income' : 'expense';
    }
    return { ...raw, type, amount_minor, is_refund, group: raw.split_total.trim() || null };
  });
}

/** Split normalized rows into groups (rows sharing a "Split Total") and solo rows. */
export function groupRows(rows: NormImportRow[]): ImportGroup[] {
  const groups: ImportGroup[] = [];
  const byKey = new Map<string, NormImportRow[]>();
  for (const r of rows) {
    if (r.group) {
      const arr = byKey.get(r.group) || [];
      arr.push(r);
      byKey.set(r.group, arr);
    } else {
      groups.push({ group: null, rows: [r] });
    }
  }
  for (const [key, arr] of byKey) groups.push({ group: key, rows: arr });
  return groups;
}

/** Escape a value for CSV output. */
export function csvEscape(v: string): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
