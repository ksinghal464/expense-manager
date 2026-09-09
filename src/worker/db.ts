import { Env, HttpError } from './http';

export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();

/**
 * Canonical transactions INSERT, shared by the create-transaction API and
 * the recurring-rule generators (manual "generate now" and the cron job)
 * so column order can never drift between them.
 */
export const INSERT_TX = `INSERT INTO transactions
  (id,account_id,payment_method_id,category_id,payee_id,transaction_type,amount_minor,occurred_at,
   description,note,status,refunds_transaction_id,
   parent_transaction_id,recurring_rule_id,is_split_parent,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const MASTER = new Set([
  'accounts',
  'categories',
  'payment_methods',
  'payees',
  'tags',
  'notes',
  'attachments',
  'recurring_rules',
]);
const CHECKABLE = new Set([
  'accounts',
  'categories',
  'payment_methods',
  'payees',
  'tags',
  'recurring_rules',
  'transactions',
]);

type Row = Record<string, any>;

export async function audit(
  env: Env,
  entityType: string,
  entityId: string,
  action: 'create' | 'update' | 'delete' | 'restore',
  before: unknown,
  after: unknown,
  metadata?: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json, metadata_json)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      id(),
      now(),
      entityType,
      entityId,
      action,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      metadata == null ? null : JSON.stringify(metadata)
    )
    .run();
}

/** Fetch a live (non-deleted) master row. */
export async function getEntity(env: Env, table: string, entityId: string): Promise<Row | null> {
  if (!MASTER.has(table)) throw new HttpError(500, 'Invalid entity table');
  return env.DB.prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`)
    .bind(entityId)
    .first<Row>();
}

/** True if the FK target exists and is live. Null/empty -> true (nullable FK). */
export async function exists(env: Env, table: string, fk: string | null): Promise<boolean> {
  if (!fk) return true;
  if (!CHECKABLE.has(table)) throw new HttpError(500, 'Invalid reference table');
  const r = await env.DB.prepare(`SELECT 1 AS ok FROM ${table} WHERE id=? AND deleted_at IS NULL`)
    .bind(fk)
    .first<{ ok: number }>();
  return !!r;
}

/** Validate that all provided FKs point at live rows. */
export async function checkFks(
  env: Env,
  refs: Record<string, string | null>
): Promise<string | null> {
  for (const [table, fk] of Object.entries(refs)) {
    if (fk && !(await exists(env, table, fk))) return `Invalid reference to ${table} (${fk}).`;
  }
  return null;
}

/** Coerce an input date (ISO or datetime-local) to a UTC ISO string. */
export function toIso(input: unknown, fallback: string = now()): string {
  const s = String(input ?? '').trim();
  if (!s) return fallback;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date');
  return d.toISOString();
}

export function asInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** toMinor that rejects NaN. */
export function toMinorStrict(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Invalid amount');
  return Math.round(n * 100);
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Run prepared statements in D1-safe chunks (batch cap is 100 statements). */
export async function runBatches(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }
}
