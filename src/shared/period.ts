/**
 * IST (Asia/Kolkata) date/period helpers. India uses a fixed +05:30 offset
 * with no DST, so a plain offset is exact and we avoid Intl/ICU entirely
 * (the Workers runtime may not load ICU data).
 */
export const IST_OFFSET_MS = 5.5 * 3600 * 1000; // +05:30

export type PeriodKind = 'day' | 'week' | 'month' | 'year';

/**
 * Start of the current period (weeks start Monday), computed in IST
 * wall-clock time and returned as a UTC ISO instant.
 */
export function periodStart(kind: PeriodKind, nowMs: number = Date.now()): string {
  const w = new Date(nowMs + IST_OFFSET_MS); // IST wall-clock read via UTC getters
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  const d = w.getUTCDate();
  let startWall: Date;
  if (kind === 'year') startWall = new Date(Date.UTC(y, 0, 1));
  else if (kind === 'month') startWall = new Date(Date.UTC(y, m, 1));
  else if (kind === 'day') startWall = new Date(Date.UTC(y, m, d));
  else {
    const dow = w.getUTCDay(); // 0=Sun .. 6=Sat
    const sinceMonday = (dow + 6) % 7;
    startWall = new Date(Date.UTC(y, m, d - sinceMonday));
  }
  return new Date(startWall.getTime() - IST_OFFSET_MS).toISOString();
}

/** UTC ISO instant for "N days ago" (wall-clock midnight IST), inclusive of today. */
export function daysAgo(n: number, nowMs: number = Date.now()): string {
  const w = new Date(nowMs + IST_OFFSET_MS);
  const startWall = new Date(
    Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - (n - 1))
  );
  return new Date(startWall.getTime() - IST_OFFSET_MS).toISOString();
}

/** Start of the *previous* calendar week/month (IST wall-clock), as a UTC ISO instant. */
export function previousPeriodStart(kind: 'week' | 'month', nowMs: number = Date.now()): string {
  const w = new Date(nowMs + IST_OFFSET_MS);
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth();
  const d = w.getUTCDate();
  let startWall: Date;
  if (kind === 'month') startWall = new Date(Date.UTC(y, m - 1, 1));
  else {
    const dow = w.getUTCDay();
    const sinceMonday = (dow + 6) % 7;
    startWall = new Date(Date.UTC(y, m, d - sinceMonday - 7));
  }
  return new Date(startWall.getTime() - IST_OFFSET_MS).toISOString();
}

/** Convert an IST wall-clock date ("yyyy-MM-dd") and optional "HH:mm" to a UTC ISO instant. */
export function istDateTimeToUTC(date: string, time = '00:00'): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallMs = Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  return new Date(wallMs - IST_OFFSET_MS).toISOString();
}

/** Convert an IST date string "dd-MM-yyyy" (legacy CSV format) to a UTC ISO instant. */
export function parseDDMMYYYY(dateStr: string): string | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return istDateTimeToUTC(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`);
}

/** Format a UTC ISO instant as an IST wall-clock "yyyy-MM-dd". */
export function toISTDate(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const w = new Date(t.getTime() + IST_OFFSET_MS);
  return (
    `${w.getUTCFullYear()}-` +
    String(w.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(w.getUTCDate()).padStart(2, '0')
  );
}
