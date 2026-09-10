import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { money, fmtDateTime, toInput, dtLocalNow, toIso, avatarLetter } from './lib';
import { Empty, Err, Field, SaveButton, Segmented, ConfirmDialog, CategoryPicker } from './ui';
import type { RecurringRule, TxType, Account, PaymentMethod, Category, Payee } from '../shared/types';

type Freq = RecurringRule['frequency'];

export function Recurring() {
  const { accounts, methods, categories, payees, refresh, toast } = useStore();
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<RecurringRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRules(await api.recurring().catch((e) => (setErr(e.message), [])));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const after = async (msg: string) => {
    toast(msg);
    await load();
    await refresh();
  };

  return (
    <main>
      <div className="cardhead topbar">
        <div>
          <h2>Recurring</h2>
          <p>Bills, salary, subscriptions — generated automatically.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          ＋ New rule
        </button>
      </div>

      {err && <Err msg={err} />}
      <section className="card">
        {rules.map((r) => (
          <div className="recurringrow" key={r.id}>
            <div className="avatar">{avatarLetter(r.description, r.name)}</div>
            <div className="txmain">
              <strong className={r.is_active ? '' : 'strikethrough'}>
                {r.name}
                {r.no_of_payments ? ` · ${r.frequency} × ${r.no_of_payments}` : ` · ${r.frequency}`}
              </strong>
              <span>
                {fmtDateTime(r.next_due_at)} ·{' '}
                {accounts.find((a) => a.id === r.account_id)?.name || ''}
              </span>
            </div>
            <b className={r.transaction_type === 'income' ? 'positive' : ''}>
              {money(r.amount_minor)}
            </b>
            <div className="recurringactions">
              <button
                className="chip"
                title="Generate next now"
                onClick={async () => {
                  setErr('');
                  try {
                    await api.generateRecurring(r.id);
                    await after('Generated');
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : '');
                  }
                }}
              >
                ▶
              </button>
              <button
                className="chip"
                title="Skip to next due"
                onClick={async () => {
                  await api.skipRecurring(r.id);
                  await after('Skipped');
                }}
              >
                ⏭
              </button>
              <button
                className="chip"
                title={r.is_active ? 'Pause' : 'Resume'}
                onClick={async () => {
                  await api.toggleRecurring(r.id);
                  await after(r.is_active ? 'Paused' : 'Resumed');
                }}
              >
                {r.is_active ? '⏸' : '▶'}
              </button>
              <button className="chip" onClick={() => setEditing(r)}>
                ✎
              </button>
              <button className="chip danger" onClick={() => setConfirmDeleteId(r.id)}>
                ×
              </button>
            </div>
          </div>
        ))}
        {!rules.length && <Empty text="No recurring rules yet." />}
      </section>

      {confirmDeleteId && (
        <ConfirmDialog
          title="Delete this rule?"
          message={`"${rules.find((r) => r.id === confirmDeleteId)?.name || 'This rule'}" will stop generating new transactions. Past transactions it already created are kept.`}
          onConfirm={async () => {
            await api.deleteRecurring(confirmDeleteId);
            await after('Deleted');
          }}
          close={() => setConfirmDeleteId(null)}
        />
      )}

      {(creating || editing) && (
        <RuleForm
          rule={editing || undefined}
          accounts={accounts}
          methods={methods}
          categories={categories}
          payees={payees}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          saved={async () => {
            setCreating(false);
            setEditing(null);
            await after('Saved');
          }}
        />
      )}
    </main>
  );
}

function RuleForm({
  rule,
  accounts,
  methods,
  categories,
  payees,
  close,
  saved,
}: {
  rule?: RecurringRule;
  accounts: Account[];
  methods: PaymentMethod[];
  categories: Category[];
  payees: Payee[];
  close: () => void;
  saved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(rule?.name || '');
  const [type, setType] = useState<TxType>(rule?.transaction_type || 'expense');
  const [accountId, setAccountId] = useState(rule?.account_id || '');
  const [methodId, setMethodId] = useState(rule?.payment_method_id || '');
  const [categoryId, setCategoryId] = useState(rule?.category_id || '');
  const [payee, setPayee] = useState(
    () => payees.find((p) => p.id === rule?.payee_id)?.name || ''
  );
  const [amount, setAmount] = useState(rule ? toInput(rule.amount_minor) : '');
  const [frequency, setFrequency] = useState<Freq>(rule?.frequency || 'monthly');
  const [interval, setInterval] = useState(String(rule?.interval_value || 1));
  const [noOfPayments, setNoOfPayments] = useState(
    rule?.no_of_payments ? String(rule.no_of_payments) : ''
  );
  const [nextDueAt, setNextDueAt] = useState(rule ? toInputLocal(rule.next_due_at) : dtLocalNow());
  const [description, setDescription] = useState(rule?.description || '');
  const [note, setNote] = useState(rule?.note || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const ms = methods.filter((m) => m.account_id === accountId);
  const cats = useMemo(
    () => categories.filter((c) => c.kind === 'both' || c.kind === type),
    [categories, type]
  );
  useEffect(() => {
    if (categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId('');
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const body: Record<string, unknown> = {
        name,
        type,
        accountId,
        methodId: methodId || null,
        categoryId: categoryId || null,
        payee,
        amount: parseFloat(amount) || 0,
        frequency,
        interval: parseInt(interval) || 1,
        noOfPayments: noOfPayments ? parseInt(noOfPayments) : null,
        nextDueAt: toIso(nextDueAt),
        description,
        note,
      };
      await api.saveRecurring(rule?.id || null, body);
      setSaving(false);
      saved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Unable to save');
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <div>
            <h2>{rule ? 'Edit rule' : 'New recurring rule'}</h2>
          </div>
          <button onClick={close}>×</button>
        </div>
        {err && <Err msg={err} />}
        <form onSubmit={submit}>
          <Field label="Name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Electricity bill"
            />
          </Field>
          <Segmented
            value={type}
            onChange={setType}
            options={[
              ['expense', 'Expense'],
              ['income', 'Income'],
            ]}
          />
          <div className="formgrid">
            <Field label="Account">
              <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="" disabled>
                  Select account
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Payment method">
              <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                <option value="">Any</option>
                {ms.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <CategoryPicker
              categories={cats}
              value={categoryId}
              onChange={setCategoryId}
              placeholder="None"
              noneLabel="None"
            />
            <Field label="Amount">
              <div className="inprefix">
                ₹
                <input
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </Field>
            <Field label="Frequency">
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Freq)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </Field>
            <Field label="Every">
              <input
                inputMode="numeric"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />
            </Field>
            <Field label="Payments (blank = forever)">
              <input
                inputMode="numeric"
                value={noOfPayments}
                onChange={(e) => setNoOfPayments(e.target.value)}
              />
            </Field>
            <Field label="First due">
              <input
                type="datetime-local"
                value={nextDueAt}
                onChange={(e) => setNextDueAt(e.target.value)}
              />
            </Field>
            <Field label="Payee / payer">
              <input
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
                list="recurring-payees"
                placeholder="Who is this with?"
              />
              <datalist id="recurring-payees">
                {payees.map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Note">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <SaveButton saving={saving} label={rule ? 'Save rule' : 'Create rule'} />
        </form>
      </div>
    </div>
  );
}

function toInputLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dtLocalNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
