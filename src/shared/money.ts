/** Round a major-currency number to minor units (paise). */
export function toMinor(amount: number | string): number {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Format minor units as an INR string, e.g. 123450 -> "₹1,234.50". */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const major = Math.abs(minor) / 100;
  return (
    sign +
    '\u20B9' +
    major.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** Parse a user-entered amount ("1,234.50") to minor units. Returns null if invalid. */
export function parseAmount(input: string): number | null {
  const cleaned = String(input).replace(/[,\s\u20b9]/gi, '');
  if (cleaned === '') return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return toMinor(n);
}

export function isValidAmountMinor(minor: number): boolean {
  return Number.isInteger(minor) && Math.abs(minor) <= 999_999_999_99;
}
