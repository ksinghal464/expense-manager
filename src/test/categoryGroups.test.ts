import { describe, it, expect } from 'vitest';
import { groupCategoryTotals } from '../client/lib';
import { TRANSFER_BUCKET_ID, TRANSFER_BUCKET_NAME } from '../shared/types';
import type { Category } from '../shared/types';

const cat = (id: string, name: string, parent_id: string | null = null): Category =>
  ({
    id,
    name,
    parent_id,
    kind: 'expense',
    sort_order: 0,
    is_active: 1,
    created_at: '',
    updated_at: '',
    deleted_at: null,
  }) as unknown as Category;

const categories: Category[] = [
  cat('food', 'Food'),
  cat('groc', 'Groceries', 'food'),
  cat('dine', 'Dining', 'food'),
  cat('rent', 'Rent'),
  cat('orph', 'Orphan sub', 'gone'), // parent deleted/inactive → not in list
];

describe('groupCategoryTotals', () => {
  it('rolls subcategories up under their main category', () => {
    const g = groupCategoryTotals(
      [
        { id: 'groc', name: 'Groceries', total: 300 },
        { id: 'dine', name: 'Dining', total: 500 },
        { id: 'rent', name: 'Rent', total: 1000 },
      ],
      categories
    );
    expect(g.map((x) => [x.id, x.total])).toEqual([
      ['rent', 1000],
      ['food', 800],
    ]);
    const food = g.find((x) => x.id === 'food')!;
    expect(food.includeSubcategories).toBe(true);
    expect(food.children).toEqual([
      { id: 'dine', name: 'Dining', total: 500 },
      { id: 'groc', name: 'Groceries', total: 300 },
    ]);
    // Rent has no subcategory amounts → not expandable.
    expect(g.find((x) => x.id === 'rent')!.children).toEqual([]);
  });

  it('shows amounts booked directly on a main category as "(no subcategory)"', () => {
    const g = groupCategoryTotals(
      [
        { id: 'food', name: 'Food', total: 50 },
        { id: 'groc', name: 'Groceries', total: 300 },
      ],
      categories
    );
    expect(g).toHaveLength(1);
    expect(g[0].total).toBe(350);
    expect(g[0].children).toEqual([
      { id: 'groc', name: 'Groceries', total: 300 },
      { id: 'food', name: 'Food (no subcategory)', total: 50 },
    ]);
  });

  it('keeps Transfer, Uncategorized, deleted and orphaned categories as flat rows', () => {
    const g = groupCategoryTotals(
      [
        { id: TRANSFER_BUCKET_ID, name: TRANSFER_BUCKET_NAME, total: 400 },
        { id: null, name: 'Uncategorized', total: 300 },
        { id: 'deleted', name: 'Old category', total: 200 },
        { id: 'orph', name: 'Orphan sub', total: 100 },
      ],
      categories
    );
    expect(
      g.map((x) => [x.id, x.name, x.total, x.includeSubcategories, x.children.length])
    ).toEqual([
      [TRANSFER_BUCKET_ID, TRANSFER_BUCKET_NAME, 400, false, 0],
      [null, 'Uncategorized', 300, false, 0],
      ['deleted', 'Old category', 200, false, 0],
      ['orph', 'Orphan sub', 100, false, 0],
    ]);
  });

  it('handles refunds that push totals negative', () => {
    const g = groupCategoryTotals(
      [
        { id: 'groc', name: 'Groceries', total: -200 },
        { id: 'dine', name: 'Dining', total: 50 },
        { id: 'rent', name: 'Rent', total: 10 },
      ],
      categories
    );
    expect(g.map((x) => [x.id, x.total])).toEqual([
      ['rent', 10],
      ['food', -150],
    ]);
    expect(g[1].children.map((c) => c.total)).toEqual([50, -200]);
  });
});
