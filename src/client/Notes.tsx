import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { fmtDateTime, dtLocalNow, toIso } from './lib';
import { Empty, Err, Field, SaveButton, Segmented } from './ui';
import type { Note, TxView } from '../shared/types';

export function Notes() {
  const { transactions, open, refresh, toast } = useStore();
  const [notes, setNotes] = useState<Note[]>([]);
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('open');
  const [editing, setEditing] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setNotes(await api.notes().catch((e) => (setErr(e.message), [])));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const after = async (msg: string) => {
    toast(msg);
    await load();
    await refresh();
  };

  const shown = notes.filter((n) =>
    filter === 'all' ? true : filter === 'done' ? n.is_done : !n.is_done
  );
  const txName = (id: string | null) =>
    id ? transactions.find((t: TxView) => t.id === id)?.description || 'Linked' : '';

  return (
    <main>
      <div className="cardhead topbar">
        <div>
          <h2>Notes & reminders</h2>
          <p>Free-form notes, optionally tied to a transaction.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          ＋ New note
        </button>
      </div>

      {err && <Err msg={err} />}
      <div className="filterline">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            ['open', 'Open'],
            ['done', 'Done'],
            ['all', 'All'],
          ]}
        />
      </div>

      <section className="card">
        {shown.map((n) => (
          <div className="noterow" key={n.id}>
            <button
              className="notedone"
              onClick={() => api.saveNote(n.id, { isDone: !n.is_done }).then(() => after(''))}
            >
              {n.is_done ? '✓' : '○'}
            </button>
            <div className="notemain">
              <strong className={n.is_done ? 'strikethrough' : ''}>
                {n.title || '(untitled)'}
              </strong>
              {n.content ? <p className={n.is_done ? 'strikethrough' : ''}>{n.content}</p> : null}
              <small>
                {n.reminder_at ? `⏰ ${fmtDateTime(n.reminder_at)}` : fmtDateTime(n.created_at)}
                {n.transaction_id ? ` · ${txName(n.transaction_id)}` : ''}
              </small>
            </div>
            <div className="recurringactions">
              <button className="chip" onClick={() => setEditing(n)}>
                ✎
              </button>
              <button
                className="chip danger"
                onClick={async () => {
                  if (confirm('Delete this note?')) {
                    await api.deleteNote(n.id);
                    await after('Deleted');
                  }
                }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
        {!shown.length && (
          <Empty text={filter === 'done' ? 'No completed notes.' : 'No notes yet.'} />
        )}
      </section>

      {(creating || editing) && (
        <NoteForm
          note={editing || undefined}
          transactions={transactions}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          saved={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </main>
  );
}

function NoteForm({
  note,
  transactions,
  close,
  saved,
}: {
  note?: Note;
  transactions: TxView[];
  close: () => void;
  saved: () => void;
}) {
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [rem, setRem] = useState(note?.reminder_at ? toLocalInput(note.reminder_at) : '');
  const [transactionId, setTransactionId] = useState(note?.transaction_id || '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await api.saveNote(note?.id || null, {
        title,
        content,
        reminderAt: rem ? toIso(rem) : null,
        transactionId: transactionId || null,
      });
      setSaving(false);
      saved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Unable to save note');
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <div>
            <h2>{note ? 'Edit note' : 'New note'}</h2>
          </div>
          <button onClick={close}>×</button>
        </div>
        {err && <Err msg={err} />}
        <form onSubmit={submit}>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Details">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} />
          </Field>
          <div className="formgrid">
            <Field label="Reminder (optional)">
              <input type="datetime-local" value={rem} onChange={(e) => setRem(e.target.value)} />
            </Field>
            <Field label="Attach to transaction">
              <select value={transactionId} onChange={(e) => setTransactionId(e.target.value)}>
                <option value="">Standalone</option>
                {transactions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.description || t.payee_name || 'Transaction'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <SaveButton saving={saving} label={note ? 'Save note' : 'Create note'} />
        </form>
      </div>
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dtLocalNow();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
