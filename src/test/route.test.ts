import { describe, it, expect } from 'vitest';
import { parseRoute, routeUrl, pageRoute, type Route } from '../client/route';
import { istDateTimeToUTC } from '../shared/period';
import { TRANSFER_BUCKET_ID } from '../shared/types';

function parse(url: string): Route {
  const u = new URL(url, 'https://x.test');
  return parseRoute(u.pathname, u.search);
}

describe('route', () => {
  it('maps paths to pages', () => {
    expect(parse('/').page).toBe('dashboard');
    expect(parse('/activity').page).toBe('activity');
    expect(parse('/recurring').page).toBe('recurring');
    expect(parse('/manage').page).toBe('manage');
    expect(parse('/nope/whatever').page).toBe('dashboard');
  });

  it('parses manage sub-tabs and falls back to accounts', () => {
    expect(parse('/manage/trash').tab).toBe('trash');
    expect(parse('/manage').tab).toBe('accounts');
    expect(parse('/manage/bogus').tab).toBe('accounts');
    expect(routeUrl({ ...pageRoute('manage'), tab: 'audit' })).toBe('/manage/audit');
    expect(routeUrl(pageRoute('manage'))).toBe('/manage');
  });

  it('round-trips a full activity filter', () => {
    const r = pageRoute('activity', {
      type: 'expense',
      accountId: 'acc1',
      categoryId: 'cat1',
      includeSubcategories: true,
      methodId: 'm1',
      payeeId: 'p1',
      status: 'cleared',
      tag: 'trip & fun',
      from: istDateTimeToUTC('2026-10-01'),
      to: istDateTimeToUTC('2026-11-01'),
      label: 'Food · October',
      q: 'swiggy dinner',
      page: 2,
    });
    const url = routeUrl(r);
    expect(url).toContain('from=2026-10-01');
    expect(url).toContain('p=3');
    expect(parse(url)).toEqual(r);
  });

  it('keeps non-midnight instants as ISO strings', () => {
    const r = pageRoute('activity', { from: '1970-01-01T00:00:00.000Z' });
    expect(parse(routeUrl(r))).toEqual(r);
  });

  it('distinguishes uncategorized from any category', () => {
    const none = pageRoute('activity', { categoryId: null });
    expect(routeUrl(none)).toBe('/activity?cat=none');
    expect(parse('/activity?cat=none').activity).toEqual({ categoryId: null });
    expect(parse('/activity').activity).toEqual({});
    const transfer = pageRoute('activity', { categoryId: TRANSFER_BUCKET_ID });
    expect(parse(routeUrl(transfer))).toEqual(transfer);
  });

  it('ignores invalid values', () => {
    expect(parse('/activity?type=bad&status=x&p=-4&from=garbage').activity).toEqual({});
    expect(parse('/activity?p=1').activity).toEqual({});
  });

  it('carries an open transaction detail on any page', () => {
    const r = parse('/manage/trash?tx=t1&trash=1');
    expect(r).toMatchObject({ page: 'manage', tab: 'trash', tx: 't1', trash: true });
    expect(routeUrl(r)).toBe('/manage/trash?tx=t1&trash=1');
    expect(routeUrl({ ...pageRoute('activity', { type: 'income' }), tx: 't2' })).toBe(
      '/activity?type=income&tx=t2'
    );
  });

  it('drops activity params and unknown params outside activity', () => {
    expect(parse('/?type=expense&drive=connected')).toEqual(pageRoute('dashboard'));
    expect(routeUrl(parse('/recurring?q=x'))).toBe('/recurring');
  });
});
