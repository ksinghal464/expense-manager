import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Category } from '../shared/types';
import { categoryRoots } from './lib';

export function Overlay({
  children,
  onClose,
  wide,
  centered,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  centered?: boolean;
}) {
  return (
    <div className={`overlay${centered ? ' centered' : ''}`} onMouseDown={onClose}>
      <div
        className={`modal${wide ? ' witemod' : ''}${centered ? ' centered' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHead({
  title,
  sub,
  onClose,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
}) {
  return (
    <div className="modalhead">
      <div>
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      <button onClick={onClose}>×</button>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

/**
 * Category picker used by every form that assigns a category: a boxed
 * button showing the current selection (bold parent › child) that opens a
 * floating panel grouping categories by parent. With more than a handful of
 * categories a live search box appears at the top of the panel so picking
 * one doesn't require scrolling through the whole list — typing filters
 * both root categories and their children (a root stays visible if it or
 * any of its children match).
 */
export function CategoryPicker({
  label = 'Category',
  required,
  categories,
  value,
  onChange,
  placeholder = 'Select category',
  noneLabel,
}: {
  label?: string;
  required?: boolean;
  /** Already filtered to whatever's relevant (e.g. by expense/income kind). */
  categories: Category[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** If set, shows a top "None" row that clears the selection. */
  noneLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const roots = useMemo(() => categoryRoots(categories), [categories]);
  const selectedLabel = useMemo(() => {
    if (!value) return '';
    const c = categories.find((x) => x.id === value);
    if (!c) return '';
    if (!c.parent_id) return c.name;
    const parent = categories.find((x) => x.id === c.parent_id);
    return parent ? `${parent.name} › ${c.name}` : c.name;
  }, [value, categories]);

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const noneVisible = !!noneLabel && matches(noneLabel);
  const visibleRoots = roots.filter(
    (r) => matches(r.name) || categories.some((c) => c.parent_id === r.id && matches(c.name))
  );

  return (
    <div className="field relative">
      <span>
        {label}
        {required ? ' *' : ''}
      </span>
      <button type="button" className="picker" onClick={() => setOpen((v) => !v)}>
        <span className={selectedLabel ? '' : 'placeholder'}>{selectedLabel || placeholder}</span>
        <span>⌄</span>
      </button>
      {open && (
        <div className="pickerpanel">
          {categories.length > 8 && (
            <input
              ref={searchRef}
              className="pickersearch"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Search categories…"
            />
          )}
          {noneVisible && (
            <div className="catsection">
              <button
                type="button"
                className={`catpick rootpick${value ? '' : ' selected'}`}
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                <b>{noneLabel}</b>
              </button>
            </div>
          )}
          {visibleRoots.map((r) => {
            const rootMatches = matches(r.name);
            const children = categories.filter(
              (c) => c.parent_id === r.id && (rootMatches || matches(c.name))
            );
            return (
              <div className="catsection" key={r.id}>
                <button
                  type="button"
                  className={`catpick rootpick${value === r.id ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(r.id);
                    setOpen(false);
                  }}
                >
                  <b>{r.name}</b>
                  <span>{r.kind}</span>
                </button>
                {children.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`catpick childpick${value === c.id ? ' selected' : ''}`}
                    onClick={() => {
                      onChange(c.id);
                      setOpen(false);
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            );
          })}
          {!visibleRoots.length && !noneVisible && (
            <p className="popupempty">No matching categories</p>
          )}
        </div>
      )}
    </div>
  );
}

export function Err({ msg }: { msg: string }) {
  return msg ? <div className="error">{msg}</div> : null;
}

export function SaveButton({
  saving,
  label,
  onClick,
  disabled,
}: {
  saving: boolean;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="submit" className="save" disabled={saving || disabled} onClick={onClick}>
      {saving ? 'Saving…' : label}
    </button>
  );
}

/** Small two/three-choice segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="segmented">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={value === id ? 'selected' : ''}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export type FieldOption = { value: string; label: string };

export type FieldDef = {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  /** Static options, or a function of the current form values (for fields
   * whose choices depend on another field, e.g. a category's valid parents
   * depend on the selected type). */
  options?: FieldOption[] | ((values: Record<string, string>) => FieldOption[]);
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
};

/** Generic modal that renders a list of typed fields and calls onSave with the values. */
export function FieldsModal({
  title,
  fields,
  initial,
  onSave,
  close,
}: {
  title: string;
  fields: FieldDef[];
  initial?: Record<string, string>;
  onSave: (v: Record<string, string>) => Promise<void>;
  close: () => void;
}) {
  const [v, setV] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const f of fields) o[f.key] = initial?.[f.key] ?? f.defaultValue ?? '';
    return o;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // If a field's options depend on another field's value (e.g. a category's
  // valid parents depend on the selected type) and the current selection is
  // no longer one of the resolved options, clear it instead of silently
  // keeping a now-invalid value selected.
  useEffect(() => {
    for (const f of fields) {
      if (f.type !== 'select' || typeof f.options !== 'function') continue;
      const resolved = f.options(v);
      if (v[f.key] && !resolved.some((o) => o.value === v[f.key])) {
        setV((cur) => ({ ...cur, [f.key]: '' }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, fields]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErr('');
    try {
      await onSave(v);
      close();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Unable to save');
      setSaving(false);
    }
  };

  return (
    <Overlay onClose={close} centered>
      <ModalHead title={title} onClose={close} />
      {err && <Err msg={err} />}
      <form className="modalform" onSubmit={submit}>
        {fields.map((f) => {
          const resolvedOptions =
            f.type === 'select'
              ? typeof f.options === 'function'
                ? f.options(v)
                : f.options || []
              : [];
          return (
            <Field key={f.key} label={f.label}>
              {f.type === 'select' ? (
                <select
                  required={f.required}
                  value={v[f.key]}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                >
                  {!resolvedOptions.some((o) => o.value === '') && (
                    <option value="" disabled>
                      {f.placeholder || `Select ${f.label.replace(/\s*\*$/, '').toLowerCase()}`}
                    </option>
                  )}
                  {resolvedOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  required={f.required}
                  placeholder={f.placeholder}
                  value={v[f.key]}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                />
              )}
            </Field>
          );
        })}
        <SaveButton saving={saving} label="Save" />
      </form>
    </Overlay>
  );
}

/**
 * Centered confirmation dialog with a built-in busy state, so a slow
 * (network) delete visibly shows "Deleting…" instead of looking frozen.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  busyLabel = 'Deleting…',
  onConfirm,
  close,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  busyLabel?: string;
  onConfirm: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      await onConfirm();
      close();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Something went wrong');
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={() => !busy && close()} centered>
      <ModalHead title={title} onClose={() => !busy && close()} />
      {err && <Err msg={err} />}
      <p className="confirmtext">{message}</p>
      <div className="detailactions">
        <button type="button" className="outline" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={run} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}
