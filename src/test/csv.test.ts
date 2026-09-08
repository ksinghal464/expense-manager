import { describe, it, expect } from 'vitest';
import { parseCsv, parseImportCsv, normalizeRows, groupRows, csvEscape } from '../shared/csv';

const HEADER =
  'Date,Amount,Category,Subcategory,Payment Method,Description,Ref/Check No,Payee/Payer,Status,Receipt Picture,Account,Tag,Tax,Quantity,Unit,Split Total,Row Id,Type Id';

// Mirrors the real CSV: original expense is NEGATIVE, refund is POSITIVE,
// same "Split Total" (= net) groups them. Category for these is Uncategorized.
const sample = [
  HEADER,
  '12-07-2026,-4523.00,Uncategorized,,Sbi cashback,Ghar,,Myntra,Cleared,,Card,,0,,1,20.76,87,1',
  '12-07-2026,4502.24,Uncategorized,,Sbi cashback,Ghar,,Myntra,Cleared,,Card,,0,,1,20.76,88,1',
  '06-12-2025,-1812.00,Food,Groceries,Icici rupay,Devnani,,Devnani,Cleared,,Card,,0,,1,,89,1',
  '15-10-2025,5000.00,Income,,Hdfc regalia,Salary,,Maa,Cleared,,AmazonPay,,0,,1,,55,1',
].join('\n');

describe('csv parser', () => {
  it('handles quoted commas and newlines', () => {
    const rows = parseCsv('a,"b, c","d\ne",f');
    expect(rows).toEqual([['a', 'b, c', 'd\ne', 'f']]);
  });
  it('locates header and reads typed rows', () => {
    const { rows, errors } = parseImportCsv('\n' + sample); // leading blank line like real export
    expect(errors).toHaveLength(0);
    expect(rows.length).toBe(4);
    expect(rows[0].split_total).toBe('20.76');
    expect(rows[0].amount).toBe('-4523.00');
    expect(rows[0].payee).toBe('Myntra');
  });
  it('reports missing header', () => {
    const { errors } = parseImportCsv('foo,bar\n1,2');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('normalize (sign -> type)', () => {
  const norm = normalizeRows(parseImportCsv(sample).rows);
  it('negative -> expense', () => {
    expect(norm[0].type).toBe('expense');
    expect(norm[0].amount_minor).toBe(452300);
    expect(norm[0].is_refund).toBe(false);
  });
  it('positive non-income -> refund (income)', () => {
    expect(norm[1].type).toBe('income');
    expect(norm[1].amount_minor).toBe(450224);
    expect(norm[1].is_refund).toBe(true);
  });
  it('positive income category -> income (not refund)', () => {
    expect(norm[3].type).toBe('income');
    expect(norm[3].is_refund).toBe(false);
  });
});

describe('grouping by Split Total', () => {
  it('groups refund rows and keeps solo rows separate', () => {
    const norm = normalizeRows(parseImportCsv(sample).rows);
    const groups = groupRows(norm);
    const refund = groups.find((g) => g.group === '20.76');
    expect(refund).toBeDefined();
    expect(refund!.rows.length).toBe(2);
    const solos = groups.filter((g) => g.group === null);
    expect(solos.length).toBe(2);
  });
});

describe('csvEscape', () => {
  it('escapes quotes/commas/newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
  });
});
