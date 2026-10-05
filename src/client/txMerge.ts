import type { TxView } from '../shared/types';

/** What a save returns besides its own payload: rows to replace and rows that are gone. */
export type TxChanges = {
  affected?: TxView[];
  removed?: string[];
  /** A payee or tag was created, so the master data lists are stale. */
  masterChanged?: boolean;
};

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** Server list order: occurred_at DESC, created_at DESC, id DESC (plain byte order, like SQLite). */
export function txOrder(a: TxView, b: TxView): number {
  return cmp(b.occurred_at, a.occurred_at) || cmp(b.created_at, a.created_at) || cmp(b.id, a.id);
}

/**
 * Apply a save's changes to the already-sorted transaction list without
 * reloading it: drop removed rows, replace changed ones and insert new ones in
 * order. Returns the same array when nothing changes.
 */
export function mergeChanges(list: TxView[], affected: TxView[], removed: string[]): TxView[] {
  if (!affected.length && !removed.length) return list;
  const drop = new Set([...removed, ...affected.map((t) => t.id)]);
  const out = list.filter((t) => !drop.has(t.id));
  for (const t of affected) {
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (txOrder(out[mid], t) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, t);
  }
  return out;
}
