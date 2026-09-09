import { useCallback, useEffect, useState } from 'react';
import { api, TxDetail as TxT, AttachmentRow } from './api';
import { useStore } from './store';
import { money, signedMoney, fmtDateTime, readFileAsDataUrl, MAX_ATTACHMENT_BYTES } from './lib';
import { Empty, Err, ConfirmDialog } from './ui';
import { AuditBody } from './auditFormat';
import type { AuditEntry } from '../shared/types';

export function TxDetail({
  id,
  fromTrash,
  close,
}: {
  id: string;
  fromTrash?: boolean;
  close: () => void;
}) {
  const { refresh, toast, open, accounts, categories, methods, payees } = useStore();
  const [tx, setTx] = useState<TxT | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [attach, setAttach] = useState<AttachmentRow[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busyAction, setBusyAction] = useState<'' | 'restore' | 'purge'>('');

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const [t, a, at] = await Promise.all([
        api.transaction(id),
        api.transactionAudit(id),
        api.attachments(id),
      ]);
      setTx(t);
      setAudit(a);
      setAttach(at);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Unable to load');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const after = async (msg: string) => {
    toast(msg);
    await load();
    await refresh();
  };

  if (loadErr)
    return (
      <div className="detail-empty">
        <Err msg={loadErr} />
        <button className="outline" onClick={close}>
          Close
        </button>
      </div>
    );
  if (!tx) return <div className="loading">Loading…</div>;

  return (
    <div className="detail">
      <div className="detailamount">
        <b className={tx.transaction_type === 'income' ? 'positive' : ''}>
          {signedMoney(tx.amount_minor, tx.transaction_type)}
        </b>
        <span>
          {tx.transaction_type === 'income' ? 'Income' : 'Expense'} · {tx.status}
          {tx.refunds_transaction_id ? ' · Refund' : ''}
          {tx.is_split_parent ? ' · Split' : ''}
        </span>
      </div>

      <div className="detailgrid">
        <Detail label="Date & time" value={fmtDateTime(tx.occurred_at)} />
        <Detail label="Account" value={tx.account_name} />
        <Detail label="Payment method" value={tx.payment_method_name || '—'} />
        <Detail label="Category" value={tx.category_name || 'Uncategorized'} />
        <Detail label="Payee / payer" value={tx.payee_name || '—'} />
        <Detail label="Description" value={tx.description || '—'} />
        <Detail label="Note" value={tx.note || '—'} />
      </div>

      {tx.tags?.length ? (
        <div className="detailtags">
          {tx.tags.map((t) => (
            <span key={t} className="chip">
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      {tx.splits?.length ? (
        <section className="mini">
          <h4>Splits</h4>
          {tx.splits.map((s) => (
            <div className="splitview" key={s.id}>
              <span>
                {s.category_name || 'Uncategorized'}
                {s.description ? ` · ${s.description}` : ''}
                {s.occurred_at && s.occurred_at !== tx.occurred_at
                  ? ` · ${fmtDateTime(s.occurred_at)}`
                  : ''}
              </span>
              <b>{money(s.amount_minor)}</b>
            </div>
          ))}
        </section>
      ) : null}

      {tx.refunds_transaction_id ? (
        <section className="mini">
          <h4>Refund of</h4>
          <button
            className="splitview refundlink"
            onClick={() => open({ kind: 'detail', id: tx.refunds_transaction_id! })}
          >
            <span>
              {tx.refund_of_description || 'Expense'}
              {tx.refund_of_occurred_at ? ` · ${fmtDateTime(tx.refund_of_occurred_at)}` : ''}
            </span>
            <b>{tx.refund_of_amount_minor != null ? money(tx.refund_of_amount_minor) : 'View →'}</b>
          </button>
          {tx.refund_siblings_total != null && tx.refund_of_amount_minor != null && (
            <div className="splitview">
              <span>This + other refunds so far</span>
              <b className="positive">
                {money(tx.refund_siblings_total)} of {money(tx.refund_of_amount_minor)}
              </b>
            </div>
          )}
        </section>
      ) : null}

      {tx.refunded_minor ? (
        <section className="mini">
          <h4>Refunded</h4>
          {(tx.refunds || []).map((r: any) => (
            <button
              className="splitview refundlink"
              key={r.id}
              onClick={() => open({ kind: 'detail', id: r.id })}
            >
              <span>
                {r.description || 'Refund'} · {fmtDateTime(r.occurred_at)}
                {r.account_name ? ` · ${r.account_name}` : ''}
              </span>
              <b className="positive">+{money(r.amount_minor)}</b>
            </button>
          ))}
          <div className="splitview">
            <span>Total refunded of {money(tx.amount_minor)}</span>
            <b className="positive">+{money(tx.refunded_minor)}</b>
          </div>
          <div className="splitview">
            <span>Net amount (after refunds)</span>
            <b>{money(tx.amount_minor - (tx.refunded_minor || 0))}</b>
          </div>
        </section>
      ) : null}

      <Attachments transactionId={id} attach={attach} onChanged={load} onToast={after} />

      <section className="history">
        <div className="cardhead">
          <div>
            <h3>History</h3>
            <p>Every change is preserved.</p>
          </div>
        </div>
        {audit.map((a) => (
          <div className="audititem" key={a.id}>
            <div className="timeline"></div>
            <div>
              <strong>{a.action.charAt(0).toUpperCase() + a.action.slice(1)}</strong>
              <small>{fmtDateTime(a.occurred_at)}</small>
              <AuditBody
                action={a.action}
                before={a.before_json}
                after={a.after_json}
                lookups={{ accounts, categories, methods, payees }}
              />
            </div>
          </div>
        ))}
        {!audit.length && <Empty text="No history recorded." />}
      </section>

      <div className="detailactions">
        {!fromTrash ? (
          <>
            <button className="outline" onClick={() => open({ kind: 'editTx', id })}>
              Edit
            </button>
            {tx.transaction_type === 'expense' && !tx.refunds_transaction_id && (
              <button className="outline" onClick={() => open({ kind: 'tx', refundOf: id })}>
                ↩ Add refund
              </button>
            )}
            <button className="danger" onClick={() => setConfirm(true)}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              className="primary"
              disabled={!!busyAction}
              onClick={async () => {
                setBusyAction('restore');
                try {
                  await api.restoreTransaction(id);
                  await after('Restored');
                  close();
                } finally {
                  setBusyAction('');
                }
              }}
            >
              {busyAction === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
            <button
              className="danger"
              disabled={!!busyAction}
              onClick={async () => {
                setBusyAction('purge');
                try {
                  await api.purgeTransaction(id);
                  await after('Permanently deleted');
                  close();
                } finally {
                  setBusyAction('');
                }
              }}
            >
              {busyAction === 'purge' ? 'Deleting…' : 'Delete forever'}
            </button>
          </>
        )}
      </div>

      {confirm && (
        <ConfirmDialog
          title="Delete this transaction?"
          message="It moves to Trash and stays in the audit log — you can restore it later from Manage → Trash."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api.deleteTransaction(id);
            await after('Moved to trash');
            close();
          }}
          close={() => setConfirm(false)}
        />
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Attachments({
  transactionId,
  attach,
  onChanged,
  onToast,
}: {
  transactionId: string;
  attach: AttachmentRow[];
  onChanged: () => Promise<void>;
  onToast: (m: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File | null) => {
    if (!f) return;
    if (f.size > MAX_ATTACHMENT_BYTES) {
      await onToast('File is too large (max 1.3 MB). Try a smaller photo or a compressed scan.');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(f);
      await api.createAttachment({
        transactionId,
        kind: f.type.startsWith('image/') ? 'image' : 'file',
        url: dataUrl,
        fileName: f.name,
        mimeType: f.type || 'application/octet-stream',
        sizeBytes: f.size,
      });
      await onToast('Attachment added');
    } catch (e) {
      await onToast(e instanceof Error ? e.message : 'Unable to add attachment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mini">
      <h4>Attachments</h4>
      {attach.map((a) => (
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
          <button className="outline" onClick={() => api.deleteAttachment(a.id).then(onChanged)}>
            Remove
          </button>
        </div>
      ))}
      <div className="attachform">
        <label className="outline attachpick">
          {busy ? 'Uploading…' : '＋ Add photo / file'}
          <input
            type="file"
            accept="image/*,application/pdf"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              e.target.value = '';
              void onFile(f);
            }}
          />
        </label>
      </div>
    </section>
  );
}
