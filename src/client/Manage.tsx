import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { money, fmtDateTime, toInput, parseJson } from './lib';
import { Empty, Err, Segmented, FieldsModal, ConfirmDialog } from './ui';
import { ImportExport } from './ImportExport';
import { TxRow } from './TxRow';
import { AuditBody } from './auditFormat';
import type {
  Account,
  Category,
  PaymentMethod,
  Payee,
  Tag,
  AuditEntry,
  CategoryKind,
  TxView,
} from '../shared/types';

type Tab = 'accounts' | 'categories' | 'methods' | 'payees' | 'tags' | 'data' | 'trash' | 'audit';

const TABS: [Tab, string][] = [
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['methods', 'Methods'],
  ['payees', 'Payees'],
  ['tags', 'Tags'],
  ['data', 'Data'],
  ['trash', 'Trash'],
  ['audit', 'Audit'],
];

export function Manage() {
  const [tab, setTab] = useState<Tab>('accounts');
  return (
    <main>
      <div className="manage-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'methods' && <MethodsTab />}
      {tab === 'payees' && <PayeesTab />}
      {tab === 'tags' && <TagsTab />}
      {tab === 'data' && <DataTab />}
      {tab === 'trash' && <TrashTab />}
      {tab === 'audit' && <AuditTab />}
    </main>
  );
}

function SectionHead({
  title,
  sub,
  onAdd,
  addLabel,
}: {
  title: string;
  sub: string;
  onAdd: () => void;
  addLabel: string;
}) {
  return (
    <div className="managerhead">
      <div>
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      <button className="primary" onClick={onAdd}>
        {addLabel}
      </button>
    </div>
  );
}

function DelBtn({ onDel, name, kind }: { onDel: () => Promise<void>; name: string; kind: string }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button type="button" className="outline" onClick={() => setConfirming(true)}>
        Delete
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Delete this ${kind}?`}
          message={`"${name}" will be hidden from pickers everywhere. Existing transactions keep their history and this can be restored later.`}
          onConfirm={onDel}
          close={() => setConfirming(false)}
        />
      )}
    </>
  );
}

// ---------------- Accounts ----------------
function AccountsTab() {
  const { accounts, refresh, toast } = useStore();
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="card manager">
      <SectionHead
        title="Accounts"
        sub="Balances and account-specific payment methods."
        onAdd={() => setCreating(true)}
        addLabel="＋ Add account"
      />
      {accounts.map((a) => (
        <div className="manage-row" key={a.id}>
          <div className="roundicon">▣</div>
          <div>
            <strong>{a.name}</strong>
            <span>Balance {money(a.balance_minor ?? a.opening_balance_minor)}</span>
          </div>
          <button className="outline" onClick={() => setEditing(a)}>
            Edit
          </button>
          <DelBtn
            name={a.name}
            kind="account"
            onDel={async () => {
              await api.deleteAccount(a.id);
              await refresh();
              toast('Account deleted');
            }}
          />
        </div>
      ))}
      {!accounts.length && <Empty text="No accounts yet." />}
      {(creating || editing) && (
        <FieldsModal
          title={editing ? 'Edit account' : 'Add account'}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          fields={[
            { key: 'name', label: 'Account name', required: true },
            {
              key: 'openingBalance',
              label: 'Opening balance',
              type: 'number',
              defaultValue: editing ? toInput(editing.opening_balance_minor) : '0',
            },
            { key: 'currency', label: 'Currency', defaultValue: editing?.currency || 'INR' },
          ]}
          initial={
            editing
              ? {
                  name: editing.name,
                  openingBalance: toInput(editing.opening_balance_minor),
                  currency: editing.currency,
                }
              : undefined
          }
          onSave={async (v) => {
            await api.saveAccount(editing?.id || null, {
              name: v.name,
              openingBalance: parseFloat(v.openingBalance) || 0,
              currency: v.currency || 'INR',
            });
            await refresh();
            toast(editing ? 'Account updated' : 'Account added');
          }}
        />
      )}
    </section>
  );
}

// ---------------- Categories ----------------
function CategoriesTab() {
  const { categories, refresh, toast } = useStore();
  const [kind, setKind] = useState<'all' | 'expense' | 'income'>('all');
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);

  const shown = categories.filter((c) => kind === 'all' || c.kind === kind || c.kind === 'both');
  const roots = shown.filter((c) => !c.parent_id);
  const topOptions = categories
    .filter((c) => !c.parent_id)
    .map((c) => ({ value: c.id, label: c.name }));

  return (
    <section className="card manager">
      <SectionHead
        title="Categories"
        sub="Build a clear hierarchy for expenses and income."
        onAdd={() => setCreating(true)}
        addLabel="＋ Add category"
      />
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          ['all', 'All'],
          ['expense', 'Expenses'],
          ['income', 'Income'],
        ]}
      />
      <div className="catlist">
        {roots.map((r) => {
          const children = shown.filter((c) => c.parent_id === r.id);
          const kindLabel =
            r.kind === 'both' ? 'Expense + Income' : r.kind === 'income' ? 'Income' : 'Expense';
          return (
            <div className="catgroup" key={r.id}>
              <div className="catrow root">
                <div className="catdot">
                  {r.kind === 'income' ? '↗' : r.kind === 'expense' ? '↘' : '↕'}
                </div>
                <div className="catinfo">
                  <strong>{r.name}</strong>
                  <span>
                    {kindLabel} · {children.length} subcategor{children.length === 1 ? 'y' : 'ies'}
                  </span>
                </div>
                <div className="catactions">
                  <button className="outline" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                  <DelBtn
                    name={r.name}
                    kind="category"
                    onDel={async () => {
                      await api.deleteCategory(r.id);
                      await refresh();
                      toast('Category deleted');
                    }}
                  />
                </div>
              </div>
              {children.map((c) => (
                <div className="catrow child" key={c.id}>
                  <div className="branch">↳</div>
                  <div className="catdot small">
                    {c.kind === 'income' ? '↗' : c.kind === 'expense' ? '↘' : '↕'}
                  </div>
                  <div className="catinfo">
                    <strong>{c.name}</strong>
                    <span>
                      {c.kind === 'both'
                        ? 'Expense + Income'
                        : c.kind === 'income'
                          ? 'Income'
                          : 'Expense'}
                    </span>
                  </div>
                  <div className="catactions">
                    <button className="outline" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <DelBtn
                      name={c.name}
                      kind="category"
                      onDel={async () => {
                        await api.deleteCategory(c.id);
                        await refresh();
                        toast('Category deleted');
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {!shown.length && <Empty text="No categories in this view." />}

      {(creating || editing) && (
        <FieldsModal
          title={editing ? 'Edit category' : 'Add category'}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          fields={[
            { key: 'name', label: 'Name', required: true },
            {
              key: 'kind',
              label: 'Type',
              type: 'select',
              options: [
                { value: 'expense', label: 'Expense' },
                { value: 'income', label: 'Income' },
                { value: 'both', label: 'Expense + Income' },
              ],
              defaultValue: 'expense',
            },
            {
              key: 'parentId',
              label: 'Parent category',
              type: 'select',
              options: [
                { value: '', label: 'No parent — top level' },
                ...topOptions.filter((o) => o.value !== editing?.id),
              ],
              defaultValue: '',
            },
          ]}
          initial={
            editing
              ? { name: editing.name, kind: editing.kind, parentId: editing.parent_id || '' }
              : undefined
          }
          onSave={async (v) => {
            await api.saveCategory(editing?.id || null, {
              name: v.name,
              kind: v.kind as CategoryKind,
              parentId: v.parentId || null,
            });
            await refresh();
            toast(editing ? 'Category updated' : 'Category added');
          }}
        />
      )}
    </section>
  );
}

// ---------------- Payment methods ----------------
function MethodsTab() {
  const { accounts, methods, refresh, toast } = useStore();
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [creating, setCreating] = useState(false);
  const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));

  return (
    <section className="card manager">
      <SectionHead
        title="Payment methods"
        sub="Methods are grouped by the account they belong to."
        onAdd={() => setCreating(true)}
        addLabel="＋ Add payment method"
      />
      {accounts.map((a) => {
        const ms = methods.filter((m) => m.account_id === a.id);
        return (
          <div className="methodgroup" key={a.id}>
            <div className="grouptitle">
              <strong>{a.name}</strong>
              <span>{ms.length}</span>
            </div>
            {ms.map((m) => (
              <div className="manage-row compact" key={m.id}>
                <div className="roundicon">◌</div>
                <div>
                  <strong>{m.name}</strong>
                  <span>Payment method</span>
                </div>
                <button className="outline" onClick={() => setEditing(m)}>
                  Edit
                </button>
                <DelBtn
                  name={m.name}
                  kind="payment method"
                  onDel={async () => {
                    await api.deletePaymentMethod(m.id);
                    await refresh();
                    toast('Method deleted');
                  }}
                />
              </div>
            ))}
            {!ms.length && <div className="groupempty">No methods for this account.</div>}
          </div>
        );
      })}
      {!accounts.length && <Empty text="Create an account before adding payment methods." />}

      {(creating || editing) && (
        <FieldsModal
          title={editing ? 'Edit payment method' : 'Add payment method'}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          fields={[
            { key: 'name', label: 'Payment method', required: true },
            {
              key: 'accountId',
              label: 'Account',
              type: 'select',
              options: accountOptions,
              required: true,
              defaultValue: editing?.account_id || '',
            },
          ]}
          initial={editing ? { name: editing.name, accountId: editing.account_id } : undefined}
          onSave={async (v) => {
            await api.savePaymentMethod(editing?.id || null, {
              name: v.name,
              accountId: v.accountId,
            });
            await refresh();
            toast(editing ? 'Method updated' : 'Method added');
          }}
        />
      )}
    </section>
  );
}

// ---------------- Payees ----------------
function PayeesTab() {
  const { payees, refresh, toast } = useStore();
  const [editing, setEditing] = useState<Payee | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="card manager">
      <SectionHead
        title="Payees"
        sub="People and places you transact with."
        onAdd={() => setCreating(true)}
        addLabel="＋ Add payee"
      />
      {payees.map((p) => (
        <div className="manage-row" key={p.id}>
          <div className="roundicon">◍</div>
          <div>
            <strong>{p.name}</strong>
            <span>{p.address || 'Payee'}</span>
          </div>
          <button className="outline" onClick={() => setEditing(p)}>
            Edit
          </button>
          <DelBtn
            name={p.name}
            kind="payee"
            onDel={async () => {
              await api.deletePayee(p.id);
              await refresh();
              toast('Payee deleted');
            }}
          />
        </div>
      ))}
      {!payees.length && <Empty text="No payees yet." />}

      {(creating || editing) && (
        <FieldsModal
          title={editing ? 'Edit payee' : 'Add payee'}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'address', label: 'Address', defaultValue: '' },
          ]}
          initial={editing ? { name: editing.name, address: editing.address } : undefined}
          onSave={async (v) => {
            await api.savePayee(editing?.id || null, { name: v.name, address: v.address });
            await refresh();
            toast(editing ? 'Payee updated' : 'Payee added');
          }}
        />
      )}
    </section>
  );
}

// ---------------- Tags ----------------
function TagsTab() {
  const { tags, refresh, toast } = useStore();
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <section className="card manager">
      <SectionHead
        title="Tags"
        sub="Flexible labels to slice your transactions."
        onAdd={() => setCreating(true)}
        addLabel="＋ Add tag"
      />
      {tags.map((t) => (
        <div className="manage-row" key={t.id}>
          <div className="roundicon">#</div>
          <div>
            <strong>{t.name}</strong>
            <span>Tag</span>
          </div>
          <button className="outline" onClick={() => setEditing(t)}>
            Edit
          </button>
          <DelBtn
            name={t.name}
            kind="tag"
            onDel={async () => {
              await api.deleteTag(t.id);
              await refresh();
              toast('Tag deleted');
            }}
          />
        </div>
      ))}
      {!tags.length && <Empty text="No tags yet." />}

      {(creating || editing) && (
        <FieldsModal
          title={editing ? 'Edit tag' : 'Add tag'}
          close={() => {
            setCreating(false);
            setEditing(null);
          }}
          fields={[{ key: 'name', label: 'Tag name', required: true }]}
          initial={editing ? { name: editing.name } : undefined}
          onSave={async (v) => {
            await api.saveTag(editing?.id || null, { name: v.name });
            await refresh();
            toast(editing ? 'Tag updated' : 'Tag added');
          }}
        />
      )}
    </section>
  );
}

// ---------------- Data ----------------
function DataTab() {
  return (
    <section className="card manager">
      <div className="managerhead">
        <div>
          <h2>Data</h2>
          <p>Export, import and back up your records.</p>
        </div>
      </div>
      <ImportExport />
    </section>
  );
}

// ---------------- Trash ----------------
function TrashTab() {
  const { open, refresh, toast } = useStore();
  const [items, setItems] = useState<TxView[]>([]);
  const [confirming, setConfirming] = useState(false);

  const loadTrash = async () => {
    try {
      return await api.trash();
    } catch {
      return [] as TxView[];
    }
  };
  const reload = useCallback(async () => setItems(await loadTrash()), []);
  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <section className="card manager">
      <div className="managerhead">
        <div>
          <h2>Trash</h2>
          <p>Deleted transactions. Restore or delete forever.</p>
        </div>
        {items.length ? (
          <button className="danger" onClick={() => setConfirming(true)}>
            Empty trash
          </button>
        ) : null}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Empty trash?"
          message={`Permanently delete all ${items.length} item${items.length === 1 ? '' : 's'} in Trash? This cannot be undone.`}
          confirmLabel="Empty trash"
          busyLabel="Emptying…"
          onConfirm={async () => {
            await api.purgeTrash();
            await reload();
            await refresh();
            toast('Trash emptied');
          }}
          close={() => setConfirming(false)}
        />
      )}
      {items.map((t) => (
        <TxRow
          key={t.id}
          t={t}
          onClick={() => open({ kind: 'detail', id: t.id, fromTrash: true })}
        />
      ))}
      {!items.length && <Empty text="Trash is empty." />}
    </section>
  );
}

// ---------------- Audit ----------------
function AuditTab() {
  const { accounts, categories, methods, payees, open } = useStore();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState('');
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    api
      .audit()
      .then(setRows)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Unable to load audit'));
  }, []);

  return (
    <section className="card manager">
      <div className="managerhead">
        <div>
          <h2>Audit log</h2>
          <p>Every change to your data, newest first.</p>
        </div>
      </div>
      {err && <Err msg={err} />}
      {rows.slice(0, limit).map((a) => {
        const isTx = a.entity_type === 'transaction';
        const snap = isTx ? parseJson(a.after_json) || parseJson(a.before_json) : null;
        return (
          <div className="globalaudit" key={a.id}>
            <div className="auditbadge">
              {a.action === 'create'
                ? '＋'
                : a.action === 'update'
                  ? '↻'
                  : a.action === 'restore'
                    ? '↺'
                    : '−'}
            </div>
            <div className="auditcontent">
              <div className="auditheadline">
                <strong>
                  {a.action.charAt(0).toUpperCase() + a.action.slice(1)}{' '}
                  {a.entity_type.replace(/_/g, ' ')}
                </strong>
                <small>{fmtDateTime(a.occurred_at)}</small>
              </div>
              {isTx && snap && (
                <button
                  type="button"
                  className="auditref"
                  onClick={() => open({ kind: 'detail', id: a.entity_id })}
                >
                  <span>
                    {(snap.description as string) ||
                      (snap.transaction_type as string) ||
                      'Transaction'}
                    {snap.amount_minor != null ? ` · ${money(Number(snap.amount_minor))}` : ''}
                    {snap.occurred_at ? ` · ${fmtDateTime(String(snap.occurred_at))}` : ''}
                  </span>
                  <b>View →</b>
                </button>
              )}
              <AuditBody
                action={a.action}
                before={a.before_json}
                after={a.after_json}
                lookups={{ accounts, categories, methods, payees }}
              />
            </div>
          </div>
        );
      })}
      {!err && !rows.length && <Empty text="No audit events yet." />}
      {rows.length > limit && (
        <button className="link" onClick={() => setLimit((l) => l + 200)}>
          Show more
        </button>
      )}
    </section>
  );
}
