import React, { useState } from 'react';

export function Overlay({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={`modal${wide ? ' witemod' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ModalHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
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

export function Err({ msg }: { msg: string }) {
  return msg ? <div className="error">{msg}</div> : null;
}

export function SaveButton({ saving, label, onClick }: { saving: boolean; label: string; onClick?: () => void }) {
  return (
    <button type="submit" className="save" disabled={saving} onClick={onClick}>
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
        <button key={id} type="button" className={value === id ? 'selected' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export type FieldDef = {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  options?: { value: string; label: string }[];
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
    <Overlay onClose={close}>
      <ModalHead title={title} onClose={close} />
      {err && <Err msg={err} />}
      <form onSubmit={submit}>
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === 'select' ? (
              <select value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                {(f.options || []).map((o) => (
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
        ))}
        <SaveButton saving={saving} label="Save" />
      </form>
    </Overlay>
  );
}

/** Inline confirm (returns a cancel/confirm button pair when armed). */
export function ConfirmButton({ onConfirm, label = 'Delete', confirmLabel = 'Confirm' }: { onConfirm: () => void; label?: string; confirmLabel?: string }) {
  const [armed, setArmed] = React.useState(false);
  if (armed) {
    return (
      <span className="confirmrow">
        <button type="button" className="outline" onClick={() => setArmed(false)}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </span>
    );
  }
  return (
    <button type="button" className="danger" onClick={() => setArmed(true)}>
      {label}
    </button>
  );
}
