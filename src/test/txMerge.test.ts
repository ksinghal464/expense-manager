import { describe, it, expect } from 'vitest';
import { mergeChanges, txOrder } from '../client/txMerge';
import type { TxView } from '../shared/types';

const tx = (id: string, occurred: string, created = '2026-01-01T00:00:00.000Z', amount = 1) =>
  ({ id, occurred_at: occurred, created_at: created, amount_minor: amount }) as TxView;

const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}T00:00:00.000Z`;
const list = [tx('c', day(5)), tx('b', day(3)), tx('a', day(1))];
const ids = (l: TxView[]) => l.map((t) => t.id);

describe('mergeChanges', () => {
  it('inserts a new row in date order', () => {
    expect(ids(mergeChanges(list, [tx('n', day(4))], []))).toEqual(['c', 'n', 'b', 'a']);
    expect(ids(mergeChanges(list, [tx('n', day(9))], []))).toEqual(['n', 'c', 'b', 'a']);
    expect(ids(mergeChanges(list, [tx('n', day(0))], []))).toEqual(['c', 'b', 'a', 'n']);
    expect(ids(mergeChanges([], [tx('n', day(0))], []))).toEqual(['n']);
  });

  it('replaces a changed row and moves it when its date changes', () => {
    const out = mergeChanges(list, [tx('a', day(4), undefined, 99)], []);
    expect(ids(out)).toEqual(['c', 'a', 'b']);
    expect(out[1].amount_minor).toBe(99);
  });

  it('removes deleted rows and refreshes related ones together', () => {
    const out = mergeChanges(list, [tx('a', day(1), undefined, 5)], ['b']);
    expect(ids(out)).toEqual(['c', 'a']);
    expect(out[1].amount_minor).toBe(5);
  });

  it('breaks date ties by created_at then id, newest first', () => {
    const same = [tx('x', day(2), day(2)), tx('y', day(2), day(1))];
    expect(ids(mergeChanges(same, [tx('z', day(2), day(1))], []))).toEqual(['x', 'z', 'y']);
    expect(ids(mergeChanges(same, [tx('m', day(2), day(3))], []))).toEqual(['m', 'x', 'y']);
  });

  it('keeps the list sorted and returns the same array for no changes', () => {
    expect(mergeChanges(list, [], [])).toBe(list);
    const out = mergeChanges(list, [tx('p', day(2)), tx('q', day(6)), tx('c', day(0))], []);
    expect(ids(out)).toEqual(['q', 'b', 'p', 'a', 'c']);
    expect([...out].sort(txOrder)).toEqual(out);
  });
});
