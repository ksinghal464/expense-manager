import { Env } from './http';
import { audit, id, now, INSERT_TX_RECURRING_IDEMPOTENT } from './db';

type Row = Record<string, any>;

/** Advance a due date by the rule's frequency * interval (UTC calendar math). */
export function advanceDue(iso: string, frequency: string, interval: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid due date');
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + interval);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + interval);
  else if (frequency === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + interval);
  else return d.toISOString();
  return d.toISOString();
}

interface Generated {
  created: number;
  skipped: number;
  deactivated: number;
}

/**
 * Generate any due recurring transactions and advance their next_due_at.
 * Idempotent: a run advances next_due_at past "now", so a re-run finds nothing due.
 */
export async function runRecurring(env: Env): Promise<Generated> {
  const asOf = now();
  const due = await env.DB.prepare(
    `SELECT * FROM recurring_rules WHERE is_active=1 AND deleted_at IS NULL AND next_due_at <= ? ORDER BY next_due_at`
  )
    .bind(asOf)
    .all<Row>();

  const res: Generated = { created: 0, skipped: 0, deactivated: 0 };
  for (const rule of due.results) {
    const generatedCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transactions WHERE recurring_rule_id=? AND deleted_at IS NULL`
    )
      .bind(rule.id)
      .first<{ n: number }>();
    const count = generatedCount?.n ?? 0;

    if (rule.no_of_payments && count + 1 > rule.no_of_payments) {
      await env.DB.prepare(`UPDATE recurring_rules SET is_active=0, updated_at=? WHERE id=?`)
        .bind(asOf, rule.id)
        .run();
      await audit(env, 'recurring_rule', rule.id, 'update', rule, { ...rule, is_active: 0 });
      res.deactivated++;
      continue;
    }

    const txId = id();
    const insertResult = await env.DB.prepare(INSERT_TX_RECURRING_IDEMPOTENT)
      .bind(
        txId,
        rule.account_id,
        rule.payment_method_id,
        rule.category_id,
        rule.payee_id,
        rule.transaction_type,
        rule.amount_minor,
        rule.next_due_at,
        rule.description || rule.name,
        rule.note || '',
        'cleared',
        null,
        null,
        rule.id,
        0,
        asOf,
        asOf
      )
      .run();

    const next = advanceDue(rule.next_due_at, rule.frequency, rule.interval_value);
    if (!insertResult.meta.changes) {
      // A transaction for this exact occurrence already exists (concurrent
      // run, or a previous run advanced next_due_at but crashed before
      // completing) — still safe to advance, but nothing new was created.
      await env.DB.prepare(`UPDATE recurring_rules SET next_due_at=?, updated_at=? WHERE id=?`)
        .bind(next, asOf, rule.id)
        .run();
      res.skipped++;
      continue;
    }

    await env.DB.prepare(
      `UPDATE recurring_rules SET next_due_at=?, last_generated_at=?, updated_at=? WHERE id=?`
    )
      .bind(next, rule.next_due_at, asOf, rule.id)
      .run();
    const createdTx = await env.DB.prepare('SELECT * FROM transactions WHERE id=?')
      .bind(txId)
      .first<Row>();
    await audit(env, 'transaction', txId, 'create', null, createdTx, { recurring: true });

    res.created++;
  }
  return res;
}
