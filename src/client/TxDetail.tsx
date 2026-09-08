import { useCallback, useEffect, useState } from 'react';
import { api, TxDetail as TxT, AttachmentRow } from './api';
import { useStore } from './store';
import { money, signedMoney, fmtDateTime, parseJson } from './lib';
import { Empty, Err } from './ui';
import type { AuditEntry, Note } from '../shared/types';

export function TxDetail({ id, fromTrash, close }: { id: string; fromTrash?: boolean; close: () => void }) {
  const { refresh, toast, open } = useStore();
  const [tx, setTx] = useState<TxT | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [attach, setAttach] = useState<AttachmentRow[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const [t, a, at, ns] = await Promise.all([
        api.transaction(id),
        api.transactionAudit(id),
        api.attachments(id),
        api.notes({ transactionId: id }),
      ]);
      setTx(t);
      setAudit(a);
      setAttach(at);
      setNotes(ns);
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

  if (loadErr) return <div className="detail-empty"><Err msg={loadErr} /><button className="outline" onClick={close}>Close</button></div>;
  if (!tx) return <div className="loading">Loading…</div>;

  return (
    <div className="detail">
      <div className="detailamount">
        <b className={tx.transaction_type === 'income' ? 'positive' : ''}>{signedMoney(tx.amount_minor, tx.transaction_type)}</b>
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
        <Detail label="Reference" value={tx.reference_number || '—'} />
        <Detail label="Description" value={tx.description || '—'} />
        <Detail label="Note" value={tx.note || '—'} />
        {tx.tax_minor ? <Detail label="Tax" value={money(tx.tax_minor)} /> : null}
        {tx.quantity != null ? <Detail label="Quantity" value={`${tx.quantity}${tx.unit ? ' ' + tx.unit : ''}`} /> : null}
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
              <span>{s.category_name || 'Uncategorized'}{s.description ? ` · ${s.description}` : ''}</span>
              <b>{money(s.amount_minor)}</b>
            </div>
          ))}
        </section>
      ) : null}

      {tx.refunded_minor ? (
        <section className="mini">
          <h4>Refunded</h4>
          <div className="splitview">
            <span>{tx.refunds?.length || 0} refund{tx.refunds?.length === 1 ? '' : 's'}</span>
            <b className="positive">+{money(tx.refunded_minor)}</b>
          </div>
        </section>
      ) : null}

      <Attachments attach={attach} onChanged={load} onToast={after} />
      <NotesBlock notes={notes} onChanged={load} onToast={after} />

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
              {a.action === 'update' && <AuditDiff before={a.before_json} after={a.after_json} />}
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
            <button className="danger" onClick={() => setConfirm(true)}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button className="primary" onClick={() => api.restoreTransaction(id).then(() => after('Restored')).then(close)}>
              Restore
            </button>
            <button className="danger" onClick={() => api.purgeTransaction(id).then(() => after('Permanently deleted')).then(close)}>
              Delete forever
            </button>
          </>
        )}
      </div>

      {confirm && (
        <div className="confirm">
          <p>Delete this transaction? It moves to Trash and stays in the audit log.</p>
          <button className="outline" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button
            className="danger"
            onClick={() =>
              api.deleteTransaction(id).then(() => after('Moved to trash')).then(() => {
                setConfirm(false);
                close();
              })
            }
          >
            Delete
          </button>
        </div>
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

function AuditDiff({ before, after }: { before: string | null; after: string | null }) {
  const b = parseJson(before) || {};
  const a = parseJson(after) || {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).filter(
    (k) => !['id', 'created_at', 'updated_at', 'deleted_at'].includes(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]),
  );
  if (!keys.length) return null;
  return (
    <div className="auditdiff">
      {keys.slice(0, 8).map((k) => (
        <div key={k}>
          <span>{k.replace(/_/g, ' ')}</span>
          <del>{b[k] == null || b[k] === '' ? '—' : String(b[k])}</del>
          <b>→</b>
          <strong>{a[k] == null || a[k] === '' ? '—' : String(a[k])}</strong>
        </div>
      ))}
    </div>
  );
}

function Attachments({ attach, onChanged, onToast }: { attach: AttachmentRow[]; onChanged: () => Promise<void>; onToast: (m: string) => Promise<void> }) {
  const [kind, setKind] = useState<'image' | 'link'>('link');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [transactionId] = useState(attach[0]?.transaction_id || '');

  const add = async () => {
    if (!url.trim()) return;
    try {
      await api.createAttachment({ transactionId, kind, url: url.trim(), fileName: fileName || url.trim() });
      setUrl('');
      setFileName('');
      await onToast('Attachment added');
    } catch (e) {
      await onToast(e instanceof Error ? e.message : 'Unable to add');
    }
  };

  return (
    <section className="mini">
      <h4>Attachments</h4>
      {attach.map((a) => (
        <div className="attachrow" key={a.id}>
          <span className="attachkind">{a.kind === 'image' ? '🖼' : '🔗'}</span>
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.file_name || a.url}
          </a>
          <button className="outline" onClick={() => api.deleteAttachment(a.id).then(onChanged)}>
            Remove
          </button>
        </div>
      ))}
      <div className="attachform">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'image' | 'link')}>
          <option value="link">Link</option>
          <option value="image">Image</option>
        </select>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="Label" />
        <button className="outline" onClick={add}>
          Add
        </button>
      </div>
    </section>
  );
}

function NotesBlock({ notes, onChanged, onToast }: { notes: Note[]; onChanged: () => Promise<void>; onToast: (m: string) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [rem, setRem] = useState('');

  const add = async () => {
    if (!title.trim() && !content.trim()) return;
    try {
      await api.saveNote(null, { transactionId: notes[0]?.transaction_id || undefined, title, content, reminderAt: rem ? new Date(rem).toISOString() : null });
      setTitle('');
      setContent('');
      setRem('');
      await onToast('Note added');
    } catch (e) {
      await onToast(e instanceof Error ? e.message : 'Unable to save note');
    }
  };

  return (
    <section className="mini">
      <h4>Notes</h4>
      {notes.map((n) => (
        <div className="noterow" key={n.id}>
          <button className="notedone" onClick={() => api.saveNote(n.id, { isDone: !n.is_done }).then(onChanged)}>
            {n.is_done ? '✓' : '○'}
          </button>
          <div>
            <strong className={n.is_done ? 'strikethrough' : ''}>{n.title}</strong>
            {n.content ? <p className={n.is_done ? 'strikethrough' : ''}>{n.content}</p> : null}
            {n.reminder_at ? <small>⏰ {fmtDateTime(n.reminder_at)}</small> : null}
          </div>
          <button className="outline" onClick={() => api.deleteNote(n.id).then(onChanged)}>
            ×
          </button>
        </div>
      ))}
      <div className="noteform">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Details" />
        <input type="datetime-local" value={rem} onChange={(e) => setRem(e.target.value)} />
        <button className="outline" onClick={add}>
          Add note
        </button>
      </div>
    </section>
  );
}
