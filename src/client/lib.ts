import { useEffect, useState } from 'react';
import { formatMinor, parseAmount, toMinor } from '../shared/money';
import { IST_OFFSET_MS } from '../shared/period';
import type { TxType, Category } from '../shared/types';

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

/** Maximum attachment size accepted client-side (keeps the base64 payload under D1/worker body caps). */
export const MAX_ATTACHMENT_BYTES = 1_400_000;

/** Read a File as a base64 data: URL (used for image/file attachments stored inline). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Unable to read file'));
    r.readAsDataURL(file);
  });
}

/** First letter (uppercased) of the first non-empty candidate, for avatar badges. */
export function avatarLetter(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.trim()) return c.trim().charAt(0).toUpperCase();
  }
  return '?';
}

/** Top-level (parent-less) categories. */
export function categoryRoots(categories: Category[]): Category[] {
  return categories.filter((c) => !c.parent_id);
}

/** Direct children of a given root category. */
export function categoryChildren(categories: Category[], rootId: string): Category[] {
  return categories.filter((c) => c.parent_id === rootId);
}

/**
 * Display name for a category, prefixed with its parent's name
 * ("Parent › Child") when it's a subcategory. A subcategory's own name
 * alone is often ambiguous or hard to distinguish from an unrelated
 * top-level category with a similar/identical name (e.g. two different
 * "Other" subcategories under different parents), so anywhere a single
 * category name is shown flat (not already visually grouped under its
 * parent, like Manage's indented category list) should use this instead of
 * the bare name.
 */
export function categoryDisplayName(
  categories: Category[],
  categoryId: string | null | undefined,
  fallbackName?: string | null
): string {
  const c = categoryId ? categories.find((x) => x.id === categoryId) : null;
  if (!c) return fallbackName || 'Uncategorized';
  if (!c.parent_id) return c.name;
  const parent = categories.find((x) => x.id === c.parent_id);
  return parent ? `${parent.name} › ${c.name}` : c.name;
}
