import { useEffect, useMemo, useState } from 'react';
import { api, TxDetail, AttachmentRow } from './api';
import { useStore } from './store';
import {
  money,
  dtLocalNow,
  toLocalInput,
  toIso,
  toInput,
  uid,
  parse,
  readFileAsDataUrl,
  MAX_ATTACHMENT_BYTES,
} from './lib';
import { Field, SaveButton, Err } from './ui';
import type {
  Category,
  PaymentMethod,
  Account,
  Payee,
  TxType,
  TxStatus,
  SplitRow,
} from '../shared/types';

type SplitDraft = {
  key: string;
  categoryId: string;
  amount: string;
  description: string;
  occurredAt: string;
};
type StagedFile = { key: string; file: File; dataUrl: string };

export function TxForm({ id, title, close }: { id?: string; title: string; close: () => void }) {
  const {
    accounts,
    categories,
    methods,
    payees,
    tags,
    suggestions,
    open,
    refresh,
    toast,
    transactions,
  } = useStore();

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
  const [refundsTxId, setRefundsTxId] = useState('');
  const [tagSel, setTagSel] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [catOpen, setCatOpen] = useState(false);
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [existingAttach, setExistingAttach] = useState<AttachmentRow[]>([]);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
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
        setRefundsTxId(t.refunds_transaction_id || '');
        setTagSel(t.tags || []);
        setSplits(
          (t.splits || []).map((s: SplitRow) => ({
            key: uid(),
            categoryId: s.category_id || '',
            amount: toInput(s.amount_minor),
            description: s.description || '',
            occurredAt: toLocalInput(s.occurred_at || t.occurred_at),
          }))
        );
        setShowAdvanced(true);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Unable to load'))
      .finally(() => setLoading(false));
    api
      .attachments(id)
      .then(setExistingAttach)
      .catch(() => setExistingAttach([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const accountMethods = useMemo(
    () => methods.filter((m) => m.account_id === accountId),
    [methods, accountId]
  );
  useEffect(() => {
    // Don't auto-pick a method; just clear it if it no longer belongs to the
    // selected account (the user must always choose explicitly).
    if (!accountMethods.some((m) => m.id === methodId)) setMethodId('');
  }, [accountId, accountMethods]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useMemo(
    () => categories.filter((c) => c.kind === 'both' || c.kind === type),
    [categories, type]
  );
  useEffect(() => {
    if (categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId('');
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const roots = cats.filter((c) => !c.parent_id);
  const selectedCategoryLabel = useMemo(() => {
    if (!categoryId) return '';
    const c = categories.find((x) => x.id === categoryId);
    if (!c) return '';
    if (!c.parent_id) return c.name;
    const parent = categories.find((x) => x.id === c.parent_id);
    return parent ? `${parent.name} › ${c.name}` : c.name;
  }, [categoryId, categories]);
  const expenses = useMemo(
    () => transactions.filter((t) => t.transaction_type === 'expense'),
    [transactions]
  );

  const addTag = (name: string) => {
    const n = name.trim().replace(/,+$/, '');
    if (!n) return;
    if (!tagSel.includes(n)) setTagSel([...tagSel, n]);
    setTagInput('');
  };

  const splitTotal = splits.reduce((s, x) => s + (parse(x.amount) || 0), 0);
  const hasSplits = splits.length >= 2;
  const splitMismatch = hasSplits && Math.abs(splitTotal - (parse(amount) || 0)) > 1;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      const minor = parse(amount);
      if (!minor || minor <= 0) throw new Error('Enter a valid amount.');
      if (!accountId) throw new Error('Select an account.');
      if (!methodId) throw new Error('Select a payment method (add one in Manage if none exist).');
      if (!categoryId) throw new Error('Select a category.');
      if (splitMismatch)
        throw new Error(`Splits must add up to ${money(minor)} (currently ${money(splitTotal)}).`);
      const payload: Record<string, unknown> = {
        type,
        accountId,
        categoryId,
        methodId,
        amount: minor / 100,
        occurredAt: toIso(date),
        description,
        note,
        status,
        payee,
        tags: tagSel,
      };
      if (type === 'income' && refundsTxId) payload.refundsTransactionId = refundsTxId;

      if (hasSplits) {
        const parts = splits.map((s) => ({
          categoryId: s.categoryId || null,
          amount: (parse(s.amount) || 0) / 100,
          description: s.description,
          note: '',
          occurredAt: s.occurredAt !== date ? toIso(s.occurredAt) : undefined,
        }));
        if (Math.abs(splitTotal - (minor || 0)) > 1)
          throw new Error('Split amounts must sum to the total.');
        payload.isSplitParent = true;
        payload.splits = parts;
      } else if (id) {
        // Editing down to <2 parts must still clear any existing splits server-side.
        payload.splits = [];
      }

      let txId = id;
      if (id) await api.updateTransaction(id, payload);
      else {
        const created = await api.createTransaction(payload);
        txId = created.id;
      }

      if (txId && staged.length) {
        for (const s of staged) {
          await api.createAttachment({
            transactionId: txId,
            kind: s.file.type.startsWith('image/') ? 'image' : 'file',
            url: s.dataUrl,
            fileName: s.file.name,
            mimeType: s.file.type || 'application/octet-stream',
            sizeBytes: s.file.size,
          });
        }
      }

      toast(id ? 'Transaction updated' : 'Transaction saved');
      await refresh();
      close();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Unable to save');
    } finally {
      setSaving(false);
    }
  };

  const onStageFile = async (f: File | null) => {
    if (!f) return;
    if (f.size > MAX_ATTACHMENT_BYTES) {
      setErr('File is too large (max 1.3 MB). Try a smaller photo or a compressed scan.');
      return;
    }
    setAttachBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(f);
      setStaged((cur) => [...cur, { key: uid(), file: f, dataUrl }]);
    } catch {
      setErr('Unable to read that file.');
    } finally {
      setAttachBusy(false);
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
        <button
          type="button"
          className={type === 'expense' ? 'chosen' : ''}
          onClick={() => setType('expense')}
        >
          − <b>Expense</b>
          <span>Money going out</span>
        </button>
        <button
          type="button"
          className={type === 'income' ? 'chosen incomechoice' : ''}
          onClick={() => setType('income')}
        >
          ＋ <b>Income</b>
          <span>Money coming in</span>
        </button>
      </div>

      <label className="amount">
        <span>Amount *</span>
        <div>
          ₹
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </label>

      <div className="formgrid">
        <Field label="Date & time">
          <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Account *">
          <select required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="" disabled>
              Select account
            </option>
            {accounts.map((a: Account) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment method *">
          <select required value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            <option value="" disabled>
              {!accountId
                ? 'Select an account first'
                : accountMethods.length
                  ? 'Select payment method'
                  : 'No methods — add one in Manage'}
            </option>
            {accountMethods.map((m: PaymentMethod) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="field relative">
          <label>Category *</label>
          <button type="button" className="picker" onClick={() => setCatOpen(!catOpen)}>
            {selectedCategoryLabel || 'Select category'}
            <span>⌄</span>
          </button>
          {catOpen && (
            <div className="pickerpanel">
              {roots.map((r) => (
                <div className="catsection" key={r.id}>
                  <button
                    type="button"
                    className={`catpick rootpick${categoryId === r.id ? ' selected' : ''}`}
                    onClick={() => {
                      setCategoryId(r.id);
                      setCatOpen(false);
                    }}
                  >
                    <b>{r.name}</b>
                    <span>{r.kind}</span>
                  </button>
                  {cats
                    .filter((c) => c.parent_id === r.id)
                    .map((c) => (
                      <button
                        type="button"
                        className={`catpick childpick${categoryId === c.id ? ' selected' : ''}`}
                        key={c.id}
                        onClick={() => {
                          setCategoryId(c.id);
                          setCatOpen(false);
                        }}
                      >
                        {c.name}
                      </button>
                    ))}
                </div>
              ))}
              {!roots.length && <p>No categories available.</p>}
            </div>
          )}
        </div>
        <Field label="Payee / payer">
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            list="payees"
            placeholder="Who was this with?"
          />
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
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Groceries at Nature's Basket"
            list="descriptions"
          />
          <datalist id="descriptions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <label className="note">
          <span>Note</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
          />
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
              <button
                type="button"
                key={t}
                className="chip"
                onClick={() => setTagSel(tagSel.filter((x) => x !== t))}
              >
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
                <button
                  type="button"
                  key={t.id}
                  className="chip ghost"
                  onClick={() => setTagSel([...tagSel, t.name])}
                >
                  +{t.name}
                </button>
              ))}
          </div>
        </div>

        <button
          type="button"
          className="link toggle-adv"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced
            ? '︿ Hide split & attachments'
            : '＋ Split into categories or add attachments'}
        </button>

        {showAdvanced && (
          <div className="adv">
            <div className="splits">
              <div className="splitshead">
                <h4>Split this amount</h4>
                <button
                  type="button"
                  className="outline"
                  disabled={!splits.length}
                  onClick={() => setSplits([])}
                >
                  Clear
                </button>
              </div>
              {splits.map((s, i) => (
                <div className="splitrow" key={s.key}>
                  <span className="splitidx">{i + 1}</span>
                  <select
                    value={s.categoryId}
                    onChange={(e) => updateSplit(s.key, { categoryId: e.target.value })}
                  >
                    <option value="">Category</option>
                    {roots.map((r) => (
                      <optgroup key={r.id} label={r.name}>
                        <option value={r.id}>{r.name} (general)</option>
                        {cats
                          .filter((c) => c.parent_id === r.id)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <input
                    inputMode="decimal"
                    className="splitamt"
                    value={s.amount}
                    onChange={(e) => updateSplit(s.key, { amount: e.target.value })}
                    placeholder="0.00"
                  />
                  <input
                    value={s.description}
                    onChange={(e) => updateSplit(s.key, { description: e.target.value })}
                    placeholder="Description"
                  />
                  <input
                    type="datetime-local"
                    className="splitdate"
                    value={s.occurredAt}
                    onChange={(e) => updateSplit(s.key, { occurredAt: e.target.value })}
                    title="Date for this split part (defaults to the transaction date)"
                  />
                  <button
                    type="button"
                    className="splitrm"
                    onClick={() => setSplits(splits.filter((x) => x.key !== s.key))}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="link"
                onClick={() =>
                  setSplits([
                    ...splits,
                    { key: uid(), categoryId: '', amount: '', description: '', occurredAt: date },
                  ])
                }
              >
                ＋ Add split part
              </button>
              {splits.length > 0 && (
                <div className={`splitsum${splitMismatch ? ' bad' : ' ok'}`}>
                  Total {money(splitTotal)} {hasSplits ? `/ ${money(parse(amount) || 0)}` : ''}
                  {splitMismatch && (
                    <span className="splitwarn">
                      ⚠ Splits must add up to the transaction amount before you can save.
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="mini">
              <h4>Attachments</h4>
              {existingAttach.map((a) => (
                <div className="attachrow" key={a.id}>
                  {a.kind === 'image' ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className="attachthumb">
                      <img src={a.url} alt={a.file_name} />
                    </a>
                  ) : (
                    <span className="attachkind">📄</span>
                  )}
                  <a href={a.url} target="_blank" rel="noreferrer" download={a.file_name}>
                    {a.file_name || 'Attachment'}
                  </a>
                  <button
                    type="button"
                    className="outline"
                    onClick={() =>
                      api
                        .deleteAttachment(a.id)
                        .then(() => setExistingAttach((cur) => cur.filter((x) => x.id !== a.id)))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {staged.map((s) => (
                <div className="attachrow" key={s.key}>
                  {s.file.type.startsWith('image/') ? (
                    <span className="attachthumb">
                      <img src={s.dataUrl} alt={s.file.name} />
                    </span>
                  ) : (
                    <span className="attachkind">📄</span>
                  )}
                  <span>{s.file.name} (pending save)</span>
                  <button
                    type="button"
                    className="outline"
                    onClick={() => setStaged((cur) => cur.filter((x) => x.key !== s.key))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="attachform">
                <label className="outline attachpick">
                  {attachBusy ? 'Reading…' : '＋ Add photo / file'}
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    disabled={attachBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      e.target.value = '';
                      void onStageFile(f);
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="statusrow">
        <span>Status</span>
        <button
          type="button"
          className={status === 'cleared' ? 'active' : ''}
          onClick={() => setStatus('cleared')}
        >
          ✓ Cleared
        </button>
        <button
          type="button"
          className={status === 'uncleared' ? 'active' : ''}
          onClick={() => setStatus('uncleared')}
        >
          ○ Uncleared
        </button>
      </div>

      <SaveButton
        saving={saving}
        disabled={splitMismatch}
        label={id ? 'Save changes' : 'Save transaction'}
      />
    </form>
  );

  function updateSplit(key: string, patch: Partial<SplitDraft>) {
    setSplits((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
}
