import { useEffect, useState } from 'react';
import { formatMinor, parseAmount, toMinor } from '../shared/money';
import { IST_OFFSET_MS } from '../shared/period';
import type { TxType } from '../shared/types';

/** ₹-formatted amount from minor units. */
export const money = (minor: number): string => formatMinor(minor);

/** ₹-formatted amount with an explicit sign based on type. */
export const signedMoney = (minor: number, type: TxType): string =>
  (type === 'income' ? '+' : '−') + money(Math.abs(minor));

/** Deterministic IST wall-clock formatting (independent of the browser timezone). */
function istDate(iso: string): Date {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return new Date('1970-01-01T00:00:00Z');
  return new Date(t.getTime() + IST_OFFSET_MS);
}

export function fmtDate(iso: string): string {
  const d = istDate(iso);
  return d.toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function fmtDateTime(iso: string): string {
  const d = istDate(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Current time as a datetime-local value (browser local; best default for a form). */
export function dtLocalNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** UTC ISO -> datetime-local value. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dtLocalNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local value -> UTC ISO. */
export function toIso(input: string): string {
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Convert a minor amount to a string suitable for an input. */
export const toInput = (minor: number): string =>
  minor ? String(Math.round((minor / 100) * 100) / 100) : '';

/** Parse an input string to minor units, or null. */
export const parse = parseAmount;

export { toMinor };

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Debounce a fast-changing value. */
export function useDebounce<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Parse a JSON column (audit before/after) into an object or null. */
export function parseJson(v: string | null): Record<string, unknown> | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
