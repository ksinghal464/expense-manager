// URL <-> app location. Pure (no DOM access) so it can be unit-tested; the
// history.pushState/popstate wiring lives in store.tsx.
//
//   /                                  dashboard
//   /activity?type=&acct=&cat=&...     activity with filters, search and page
//   /recurring
//   /manage/<tab>                      manage sub-tab (accounts when omitted)
//   ...?tx=<id>[&trash=1]              transaction detail open on top of any page
import { istDateTimeToUTC, toISTDate } from '../shared/period';

export type Page = 'dashboard' | 'activity' | 'recurring' | 'manage';

export const MANAGE_TABS = [
  'accounts',
  'categories',
  'methods',
  'payees',
  'tags',
  'data',
  'trash',
  'audit',
] as const;
export type ManageTab = (typeof MANAGE_TABS)[number];

export type ActivityFilter = {
  type?: 'expense' | 'income';
  accountId?: string;
  /** undefined = any category, null = uncategorized. */
  categoryId?: string | null;
  /** With categoryId: also match transactions in its subcategories. */
  includeSubcategories?: boolean;
  methodId?: string;
  payeeId?: string;
  status?: 'cleared' | 'uncleared';
  tag?: string;
  from?: string;
  to?: string | null;
  label?: string;
};

export type ActivityState = ActivityFilter & {
  q?: string;
  /** 0-based list page. */
  page?: number;
};

export interface Route {
  page: Page;
  tab: ManageTab;
  activity: ActivityState;
  /** Transaction whose detail is open. */
  tx?: string;
  /** The open detail was reached from Trash. */
  trash?: boolean;
}

const PATHS: Record<Page, string> = {
  dashboard: '/',
  activity: '/activity',
  recurring: '/recurring',
  manage: '/manage',
};

const UNCATEGORIZED = 'none';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** IST-midnight instants are written as YYYY-MM-DD; anything else stays a full ISO string. */
function encodeInstant(iso: string): string {
  const day = toISTDate(iso);
  return day && istDateTimeToUTC(day) === iso ? day : iso;
}

function decodeInstant(v: string | null): string | undefined {
  if (!v) return undefined;
  if (DATE_ONLY.test(v)) return istDateTimeToUTC(v);
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

function oneOf<T extends string>(v: string | null, allowed: readonly T[]): T | undefined {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export function parseRoute(pathname: string, search: string): Route {
  const qs = new URLSearchParams(search);
  const parts = pathname.split('/').filter(Boolean);
  const head = parts[0] || '';
  const page: Page =
    head === 'activity' || head === 'recurring' || head === 'manage' ? head : 'dashboard';
  const tab = (page === 'manage' && oneOf(parts[1] || null, MANAGE_TABS)) || 'accounts';

  const activity: ActivityState = {};
  if (page === 'activity') {
    const str = (k: string) => qs.get(k) || undefined;
    activity.type = oneOf(qs.get('type'), ['expense', 'income'] as const);
    activity.accountId = str('acct');
    const cat = qs.get('cat');
    if (cat) {
      activity.categoryId = cat === UNCATEGORIZED ? null : cat;
      activity.includeSubcategories = cat !== UNCATEGORIZED && qs.get('sub') === '1';
    }
    activity.methodId = str('method');
    activity.payeeId = str('payee');
    activity.status = oneOf(qs.get('status'), ['cleared', 'uncleared'] as const);
    activity.tag = str('tag');
    activity.from = decodeInstant(qs.get('from'));
    activity.to = decodeInstant(qs.get('to'));
    activity.label = str('label');
    activity.q = str('q');
    const p = Number(qs.get('p'));
    if (Number.isInteger(p) && p > 1) activity.page = p - 1;
    for (const k of Object.keys(activity) as (keyof ActivityState)[]) {
      if (activity[k] === undefined || activity[k] === false) delete activity[k];
    }
  }

  const route: Route = { page, tab, activity };
  const tx = qs.get('tx');
  if (tx) {
    route.tx = tx;
    if (qs.get('trash') === '1') route.trash = true;
  }
  return route;
}

export function routeUrl(r: Route): string {
  let path = PATHS[r.page];
  if (r.page === 'manage' && r.tab !== 'accounts') path += `/${r.tab}`;
  const qs = new URLSearchParams();
  if (r.page === 'activity') {
    const a = r.activity;
    if (a.type) qs.set('type', a.type);
    if (a.accountId) qs.set('acct', a.accountId);
    if (a.categoryId !== undefined) {
      qs.set('cat', a.categoryId === null ? UNCATEGORIZED : a.categoryId);
      if (a.categoryId !== null && a.includeSubcategories) qs.set('sub', '1');
    }
    if (a.methodId) qs.set('method', a.methodId);
    if (a.payeeId) qs.set('payee', a.payeeId);
    if (a.status) qs.set('status', a.status);
    if (a.tag) qs.set('tag', a.tag);
    if (a.from) qs.set('from', encodeInstant(a.from));
    if (a.to) qs.set('to', encodeInstant(a.to));
    if (a.label) qs.set('label', a.label);
    if (a.q) qs.set('q', a.q);
    if (a.page && a.page > 0) qs.set('p', String(a.page + 1));
  }
  if (r.tx) {
    qs.set('tx', r.tx);
    if (r.trash) qs.set('trash', '1');
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export function pageRoute(page: Page, activity: ActivityState = {}): Route {
  return { page, tab: 'accounts', activity };
}
