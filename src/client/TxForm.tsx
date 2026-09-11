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
  fmtDateTime,
  categoryRoots,
  categoryChildren,
} from './lib';
import { Field, SaveButton, Err, CategoryPicker, AttachmentPreview } from './ui';
import type { Category, PaymentMethod, Account, Payee, TxStatus, SplitRow } from '../shared/types';

type SplitDraft = {
  key: string;
  categoryId: string;
  amount: string;
  description: string;
  occurredAt: string;
};
type StagedFile = { key: string; file: File; dataUrl: string };
// The form's own type choice is a superset of the persisted TxType: a
// "transfer" isn't a transaction_type value at all — it's two linked
// transaction rows (see createTransfer/updateTransfer in routes.ts) — so it
// gets its own local union here instead of reusing TxType directly.
type FormType = 'expense' | 'income' | 'transfer';

// The split-into-multiple-categories editor is hidden for now (it was causing
// user confusion) but left in place — flip this back to `true` to re-enable
// the UI without touching any of the underlying logic/data handling.
const SHOW_SPLIT_EDITOR = false;

export function TxForm({
  id,
  title,
  refundOf,
  close,
}: {
  id?: string;
  title: string;
  refundOf?: string;
  close: () => void;
}) {
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
  const [type, setType] = useState<FormType>('expense');
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [toMethodId, setToMethodId] = useState('');
  const [transferId, setTransferId] = useState<string | null>(null);
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
  const [descOpen, setDescOpen] = useState(false);
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [existingAttach, setExistingAttach] = useState<AttachmentRow[]>([]);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [previewAttach, setPreviewAttach] = useState<{ url: string; fileName?: string } | null>(
    null,
  );

  useEffect(() => {
    if (!id) return;
    api
      .transaction(id)
      .then((t: TxDetail) => {
        if (t.transfer_id) {
          // A transfer-linked leg: switch the form into transfer mode and
          // derive the from/to accounts and payment methods from which side
          // of the transfer this particular leg is (see PUT
          // /api/transfers/:id — accounts aren't editable after creation,
          // only amount/date/description/note/payment methods).
          setType('transfer');
          setTransferId(t.transfer_id);
          if (t.transaction_type === 'expense') {
            setAccountId(t.account_id);
            setToAccountId(t.transfer_counterpart_account_id || '');
            setMethodId(t.payment_method_id || '');
            setToMethodId(t.transfer_counterpart_method_id || '');
          } else {
            setAccountId(t.transfer_counterpart_account_id || '');
            setToAccountId(t.account_id);
            setMethodId(t.transfer_counterpart_method_id || '');
            setToMethodId(t.payment_method_id || '');
          }
        } else {
          setType(t.transaction_type);
          setAccountId(t.account_id);
          setMethodId(t.payment_method_id || '');
        }
        setCategoryId(t.category_id || '');
        setAmount(toInput(t.amount_minor));
        setDate(toLocalInput(t.occurred_at));
        // A transfer leg's own `description` is auto-generated per direction
        // ("Transfer to X" / "Transfer from Y") for display — the editable
        // field must instead reflect the transfer's raw custom description
        // (blank unless the user set one), or re-saving would "freeze" one
        // leg's auto-text onto both legs.
        setDescription(t.transfer_id ? t.transfer_description || '' : t.description);
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
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Unable to load'))
      .finally(() => setLoading(false));
    api
      .attachments(id)
      .then(setExistingAttach)
      .catch(() => setExistingAttach([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Seed a new transaction as a refund of an existing expense (opened via
  // "Add refund" on that expense's detail page): same account/category/
  // payment method/payee so it's easy to just enter the refunded amount.
  useEffect(() => {
    if (id || !refundOf) return;
    api
      .transaction(refundOf)
      .then((t: TxDetail) => {
        setType('income');
        setAccountId(t.account_id);
        setCategoryId(t.category_id || '');
        setMethodId(t.payment_method_id || '');
        setPayee(t.payee_name || '');
        setRefundsTxId(refundOf);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Unable to load refund target'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, refundOf]);

  const accountMethods = useMemo(
    () => methods.filter((m) => m.account_id === accountId),
    [methods, accountId]
  );
  useEffect(() => {
    // Don't auto-pick a method; just clear it if it no longer belongs to the
    // selected account (the user must always choose explicitly).
    if (!accountMethods.some((m) => m.id === methodId)) setMethodId('');
  }, [accountId, accountMethods]); // eslint-disable-line react-hooks/exhaustive-deps

  const toAccountMethods = useMemo(
    () => methods.filter((m) => m.account_id === toAccountId),
    [methods, toAccountId]
  );
  useEffect(() => {
    if (!toAccountMethods.some((m) => m.id === toMethodId)) setToMethodId('');
  }, [toAccountId, toAccountMethods]); // eslint-disable-line react-hooks/exhaustive-deps

  const cats = useMemo(
    () =>
      type === 'transfer' ? [] : categories.filter((c) => c.kind === 'both' || c.kind === type),
    [categories, type]
  );
  useEffect(() => {
    if (categoryId && !cats.some((c) => c.id === categoryId)) setCategoryId('');
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const roots = categoryRoots(cats);
  const expenses = useMemo(
    // A transfer's outgoing leg is transaction_type='expense' too, but it
    // isn't a real expense — exclude it so it can't be picked as a refund
    // target (refunding a transfer doesn't make sense).
    () => transactions.filter((t) => t.transaction_type === 'expense' && !t.transfer_id),
    [transactions]
  );

  // Autocomplete for the description field: match the whole typed phrase as a
  // substring of a saved suggestion; with an empty field show the most-used
  // values so existing descriptions are easy to pick.
  const descMatches = useMemo(() => {
    const q = description.trim().toLowerCase();
    if (!q) return suggestions.slice(0, 12);
    return suggestions.filter((s) => s.toLowerCase().includes(q)).slice(0, 12);
  }, [description, suggestions]);

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

      if (type === 'transfer') {
        if (!accountId) throw new Error('Select a from account.');
        if (!toAccountId) throw new Error('Select a to account.');
        if (accountId === toAccountId) throw new Error('From and to accounts must be different.');
        const transferPayload = {
          fromAccountId: accountId,
          toAccountId,
          fromMethodId: methodId || null,
          toMethodId: toMethodId || null,
          amount: minor / 100,
          occurredAt: toIso(date),
          description,
          note,
          status,
        };
        if (transferId) await api.updateTransfer(transferId, transferPayload);
        else await api.createTransfer(transferPayload);
        toast(transferId ? 'Transfer updated' : 'Transfer saved');
        close();
        refresh();
        return;
      }

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
      if (type === 'income') {
        // Send explicitly (including null) on edit so clearing the refund
        // link server-side actually clears it instead of being ignored.
        payload.refundsTransactionId = refundsTxId || (id ? null : undefined);
      }

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
      close();
      refresh();
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
          disabled={!!transferId}
          onClick={() => setType('expense')}
        >
          − <b>Expense</b>
          <span>Money going out</span>
        </button>
        <button
          type="button"
          className={type === 'income' ? 'chosen incomechoice' : ''}
          disabled={!!transferId}
          onClick={() => setType('income')}
        >
          ＋ <b>Income</b>
          <span>Money coming in</span>
        </button>
        <button
          type="button"
          className={type === 'transfer' ? 'chosen transferchoice' : ''}
          disabled={(!!id && !transferId) || accounts.length < 2}
          title={accounts.length < 2 ? 'Add a second account to transfer between accounts' : ''}
          onClick={() => setType('transfer')}
        >
          ⇄ <b>Transfer</b>
          <span>Between your accounts</span>
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

      {type === 'transfer' ? (
        <div className="formgrid">
          <Field label="Date & time">
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="From account *">
            <select
              required
              disabled={!!transferId}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="" disabled>
                Select account
              </option>
              {accounts
                .filter((a) => a.id !== toAccountId)
                .map((a: Account) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="To account *">
            <select
              required
              disabled={!!transferId}
              value={toAccountId}
              onChange={(e) => setToAccountId(e.target.value)}
            >
              <option value="" disabled>
                Select account
              </option>
              {accounts
                .filter((a) => a.id !== accountId)
                .map((a: Account) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="From payment method">
            <select
              value={methodId}
              disabled={!accountId}
              onChange={(e) => setMethodId(e.target.value)}
            >
              <option value="">{!accountId ? 'Select from account first' : 'None'}</option>
              {accountMethods.map((m: PaymentMethod) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To payment method">
            <select
              value={toMethodId}
              disabled={!toAccountId}
              onChange={(e) => setToMethodId(e.target.value)}
            >
              <option value="">{!toAccountId ? 'Select to account first' : 'None'}</option>
              {toAccountMethods.map((m: PaymentMethod) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : (
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
          <CategoryPicker
            label="Category"
            required
            categories={cats}
            value={categoryId}
            onChange={setCategoryId}
          />
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
      )}

      <div className="details">
        <div className="relative">
          <label>Description</label>
          <input
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setDescOpen(true);
            }}
            onFocus={() => setDescOpen(true)}
            onBlur={() => window.setTimeout(() => setDescOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDescOpen(false);
            }}
            placeholder="e.g. Groceries at Nature's Basket"
            autoComplete="off"
          />
          {descOpen && suggestions.length > 0 && (
            <div className="descpopup">
              {descMatches.length ? (
                descMatches.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setDescription(s);
                      setDescOpen(false);
                    }}
                  >
                    {s}
                  </button>
                ))
              ) : (
                <div className="popupempty">No matching saved values</div>
              )}
            </div>
          )}
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
                  {fmtDateTime(t.occurred_at)} · {money(t.amount_minor)} ·{' '}
                  {t.status === 'uncleared' ? 'Uncleared' : 'Cleared'} ·{' '}
                  {t.description || t.payee_name || 'Expense'}
                  {t.note ? ` — ${t.note}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}

        {type !== 'transfer' && (
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
        )}

        {type !== 'transfer' && (
          <div className="adv">
            {SHOW_SPLIT_EDITOR && (
              <div className="splits">
                <div className="splitshead">
                  <h4>
                    Split this amount{' '}
                    <span className="splitof">of {money(parse(amount) || 0)}</span>
                  </h4>
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
                          {categoryChildren(cats, r.id).map((c) => (
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
            )}

            <div className="mini">
              <h4>Attachments</h4>
              {existingAttach.map((a) => (
                <div className="attachrow" key={a.id}>
                  {a.kind === 'image' ? (
                    <button
                      type="button"
                      className="attachthumb"
                      onClick={() => setPreviewAttach({ url: a.url, fileName: a.file_name })}
                    >
                      <img src={a.url} alt={a.file_name} />
                    </button>
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
                    <button
                      type="button"
                      className="attachthumb"
                      onClick={() => setPreviewAttach({ url: s.dataUrl, fileName: s.file.name })}
                    >
                      <img src={s.dataUrl} alt={s.file.name} />
                    </button>
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

      {previewAttach && (
        <AttachmentPreview
          url={previewAttach.url}
          fileName={previewAttach.fileName}
          onClose={() => setPreviewAttach(null)}
        />
      )}

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
        label={id ? 'Save changes' : type === 'transfer' ? 'Save transfer' : 'Save transaction'}
      />
    </form>
  );

  function updateSplit(key: string, patch: Partial<SplitDraft>) {
    setSplits((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }
}
