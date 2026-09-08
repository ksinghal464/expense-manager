import { useEffect, useMemo, useState } from 'react';
import { api, TxDetail } from './api';
import { useStore } from './store';
import { money, dtLocalNow, toLocalInput, toIso, toInput, uid, parse } from './lib';
import { Field, SaveButton, Err } from './ui';
import type { Category, PaymentMethod, Account, Payee, TxType, TxStatus, SplitRow } from '../shared/types';

type SplitDraft = { key: string; categoryId: string; amount: string; description: string };

export function TxForm({
  id,
  title,
  close,
}: {
  id?: string;
  title: string;
  close: () => void;
}) {
  const { accounts, categories, methods, payees, tags, suggestions, open, refresh, toast, transactions } = useStore();

  const [loading, setLoading] = useState(!!id);
  const [type, setType] = useState<TxType>('expense');
  const [accountId, setAccountId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dtLocalNow());
  const [description, setDescription] = useState('');
  const [note, setNote] = useState('');
  const [payee, setPayee] = useState('');
  const [status, setStatus] = useState<TxStatus>('cleared');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [tax, setTax] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [refundsTxId, setRefundsTxId] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [catOpen, setCatOpen] = useState(false);
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) {
      setAccountId(accounts[0]?.id || '');
      return;
    }
    api
      .transaction(id)
      .then((t: TxDetail) => {
        setType(t.transaction_type);
        setAccountId(t.account_id);
        setCategoryId(t.category_id || '');
        setMethodId(t.payment_method_id || '');
        setAmount(toInput(t.amount_minor));
        setDate(toLocalInput(t.occurred_at));
        setDescription(t.description);
        setNote(t.note);
        setPayee(t.payee_name || '');
        setStatus(t.status);
        setReferenceNumber(t.reference_number || '');
        setTax(t.tax_minor ? toInput(t.tax_minor) : '');
        setQuantity(t.quantity != null ? String(t.quantity) : '');
        setUnit(t.unit || '');
        setRefundsTxId(t.refunds_transaction_id || '');
        setTagSel(t.tags || []);
        setSplits((t.splits || []).map((s: SplitRow) => ({ key: uid(), categoryId: s.category_id || '', amount: toInput(s.amount_minor), description: s.description || '' })));
        setShowAdvanced(true);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Unable to load'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const accountMethods = useMemo(() => methods.filter((m) => m.account_id === accountId), [methods, accountId]);
  useEffect(() => {
    if (!accountMethods.some((m) => m.id === methodId)) setMethodId('');
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useMemo(() => categories.filter((c) => c.kind === 'both' || c.kind === type), [categories, type]);
  useEffect(() => {
    if (categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId('');
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const roots = cats.filter((c) => !c.parent_id);
  const expenses = useMemo(() => transactions.filter((t) => t.transaction_type === 'expense'), [transactions]);

  const addTag = (name: string) => {
    const n = name.trim().replace(/,+$/, '');
    if (!n) return;
    if (!tagSel.includes(n)) setTagSel([...tagSel, n]);
    setTagInput('');
  };

  const splitTotal = splits.reduce((s, x) => s + (parse(x.amount) || 0), 0);
  const hasSplits = splits.length >= 2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const minor = parse(amount);
      if (!minor || minor <= 0) throw new Error('Enter a valid amount.');
      const payload: Record<string, unknown> = {
        type,
        accountId,
        categoryId: categoryId || null,
        methodId: methodId || null,
        amount: minor / 100,
        occurredAt: toIso(date),
        description,
        note,
        status,
        referenceNumber,
        payee,
        tags: tagSel,
      };
      if (tax) payload.tax = tax;
      if (quantity) payload.quantity = quantity;
      if (unit) payload.unit = unit;
      if (type === 'income' && refundsTxId) payload.refundsTransactionId = refundsTxId;

      if (hasSplits) {
        const parts = splits.map((s) => ({ categoryId: s.categoryId || null, amount: (parse(s.amount) || 0) / 100, description: s.description, note: '' }));
        if (Math.abs(splitTotal - (minor || 0)) > 1) throw new Error('Split amounts must sum to the total.');
        payload.isSplitParent = true;
        payload.splits = parts;
      }

      if (id) await api.updateTransaction(id, payload);
      else await api.createTransaction(payload);
      toast(id ? 'Transaction updated' : 'Transaction saved');
      await refresh();
      close();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Unable to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;

  if (!accounts.length) {
    return (
      <div className="empty">
        <p>You need an account first.</p>
        <button className="primary" onClick={() => open({ kind: 'account' })}>
          Create account
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      {err && <Err msg={err} />}

      <div className="typechoice">
        <button type="button" className={type === 'expense' ? 'chosen' : ''} onClick={() => setType('expense')}>
          − <b>Expense</b>
          <span>Money going out</span>
        </button>
        <button type="button" className={type === 'income' ? 'chosen incomechoice' : ''} onClick={() => setType('income')}>
          ＋ <b>Income</b>
          <span>Money coming in</span>
        </button>
      </div>

      <label className="amount">
        <span>Amount</span>
        <div>
          ₹<input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
      </label>

      <div className="formgrid">
        <Field label="Date & time">
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Account">
          <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a: Account) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment method">
          <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            <option value="">Any / none</option>
            {accountMethods.map((m: PaymentMethod) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="field relative">
          <label>Category</label>
          <button type="button" className="picker" onClick={() => setCatOpen(!catOpen)}>
            {categoryId ? categories.find((c) => c.id === categoryId)?.name : 'Select category'}
            <span>⌄</span>
          </button>
          {catOpen && (
            <div className="pickerpanel">
              {roots.map((r) => (
                <div key={r.id}>
                  <button type="button" className="catpick rootpick" onClick={() => { setCategoryId(r.id); setCatOpen(false); }}>
                    {r.name}
                    <span>{r.kind}</span>
                  </button>
                  {cats
                    .filter((c) => c.parent_id === r.id)
                    .map((c) => (
                      <button type="button" className="catpick childpick" key={c.id} onClick={() => { setCategoryId(c.id); setCatOpen(false); }}>
                        ↳ {c.name}
                      </button>
                    ))}
                </div>
              ))}
              {!roots.length && <p>No categories available.</p>}
            </div>
          )}
        </div>
        <Field label="Payee / payer">
          <input value={payee} onChange={(e) => setPayee(e.target.value)} list="payees" placeholder="Who was this with?" />
          <datalist id="payees">
            {payees.map((p: Payee) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </Field>
      </div>

      <div className="details">
        <h3>Details</h3>
        <div className="relative">
          <label>Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Groceries at Nature's Basket" list="descriptions" />
          <datalist id="descriptions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <label className="note">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" />
        </label>

        {type === 'income' && (
          <Field label="Refund of (optional)">
            <select value={refundsTxId} onChange={(e) => setRefundsTxId(e.target.value)}>
              <option value="">Not a refund</option>
              {expenses.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.description || t.payee_name || 'Expense'} · {money(t.amount_minor)}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="tagrow">
          <span>Tags</span>
          <div className="tagchips">
            {tagSel.map((t) => (
              <button type="button" key={t} className="chip" onClick={() => setTagSel(tagSel.filter((x) => x !== t))}>
                #{t} <i>×</i>
              </button>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag(tagInput);
                }
              }}
              onBlur={() => tagInput && addTag(tagInput)}
              placeholder="Add tag ⏎"
              list="taglist"
            />
            <datalist id="taglist">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
            {tags
              .filter((t) => !tagSel.includes(t.name))
              .slice(0, 6)
              .map((t) => (
                <button type="button" key={t.id} className="chip ghost" onClick={() => setTagSel([...tagSel, t.name])}>
                  +{t.name}
                </button>
              ))}
          </div>
        </div>

        <button type="button" className="link toggle-adv" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? 'Hide' : 'Show'} advanced & splits ⌄
        </button>

        {showAdvanced && (
          <div className="adv">
            <div className="formgrid">
              <Field label="Reference / check no.">
                <input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
              </Field>
              <Field label="Tax (₹)">
                <input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="0.00" />
              </Field>
              <Field label="Quantity">
                <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </Field>
              <Field label="Unit">
                <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="kg / hr / L" />
              </Field>
            </div>

            <div className="splits">
              <div className="splitshead">
                <h4>Split this amount</h4>
                <button type="button" className="outline" disabled={!splits.length} onClick={() => setSplits([])}>
                  Clear
                </button>
              </div>
              {splits.map((s, i) => (
                <div className="splitrow" key={s.key}>
                  <span className="splitidx">{i + 1}</span>
                  <select value={s.categoryId} onChange={(e) => updateSplit(s.key, { categoryId: e.target.value })}>
                    <option value="">Category</option>
                    {cats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parent_id ? '↳ ' : ''}
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input inputMode="decimal" className="splitamt" value={s.amount} onChange={(e) => updateSplit(s.key, { amount: e.target.value })} placeholder="0.00" />
                  <input value={s.description} onChange={(e) => updateSplit(s.key, { description: e.target.value })} placeholder="Description" />
                  <button type="button" className="splitrm" onClick={() => setSplits(splits.filter((x) => x.key !== s.key))}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" className="link" onClick={() => setSplits([...splits, { key: uid(), categoryId: '', amount: '', description: '' }])}>
                ＋ Add split part
              </button>
              {splits.length > 0 && (
                <div className={`splitsum${hasSplits && Math.abs(splitTotal - (parse(amount) || 0)) <= 1 ? ' ok' : ' bad'}`}>
                  Total {money(splitTotal)} {hasSplits ? `/ ${money(parse(amount) || 0)}` : ''}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="statusrow">
        <span>Status</span>
        <button type="button" className={status === 'cleared' ? 'active' : ''} onClick={() => setStatus('cleared')}>
          ✓ Cleared
        </button>
        <button type="button" className={status === 'uncleared' ? 'active' : ''} onClick={() => setStatus('uncleared')}>
          ○ Uncleared
        </button>
      </div>

      <SaveButton saving={saving} label={id ? 'Save changes' : 'Save transaction'} />
    </form>
  );

  function updateSplit(key: string, patch: Partial<SplitDraft>) {
    setSplits((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
}
