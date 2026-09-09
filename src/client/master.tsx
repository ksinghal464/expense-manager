import { FieldsModal } from './ui';
import { useStore, type Modal } from './store';
import { api } from './api';
import { toInput } from './lib';
import type { CategoryKind } from '../shared/types';

export function MasterModal({ modal, close }: { modal: NonNullable<Modal>; close: () => void }) {
  const { accounts, categories, refresh, toast } = useStore();

  if (modal.kind === 'account') {
    const item = modal.item;
    return (
      <FieldsModal
        title={item ? 'Edit account' : 'Add account'}
        close={close}
        fields={[
          { key: 'name', label: 'Account name', required: true },
          {
            key: 'openingBalance',
            label: 'Opening balance',
            type: 'number',
            defaultValue: item ? toInput(item.opening_balance_minor) : '0',
          },
          { key: 'currency', label: 'Currency', defaultValue: item?.currency || 'INR' },
        ]}
        initial={
          item
            ? {
                name: item.name,
                openingBalance: toInput(item.opening_balance_minor),
                currency: item.currency,
              }
            : undefined
        }
        onSave={async (v) => {
          await api.saveAccount(item?.id || null, {
            name: v.name,
            openingBalance: parseFloat(v.openingBalance) || 0,
            currency: v.currency || 'INR',
          });
          await refresh();
          toast(item ? 'Account updated' : 'Account added');
        }}
      />
    );
  }

  if (modal.kind === 'category') {
    const item = modal.item;
    const topOptions = categories
      .filter((c) => !c.parent_id && c.id !== item?.id)
      .map((c) => ({ value: c.id, label: c.name }));
    return (
      <FieldsModal
        title={item ? 'Edit category' : 'Add category'}
        close={close}
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
            options: (v: Record<string, string>) => {
              const wantKind = v.kind || 'expense';
              return [
                { value: '', label: 'No parent — top level' },
                ...topOptions.filter((o) => {
                  const cat = categories.find((c) => c.id === o.value);
                  return cat && (cat.kind === 'both' || cat.kind === wantKind);
                }),
              ];
            },
            defaultValue: '',
          },
        ]}
        initial={
          item ? { name: item.name, kind: item.kind, parentId: item.parent_id || '' } : undefined
        }
        onSave={async (v) => {
          await api.saveCategory(item?.id || null, {
            name: v.name,
            kind: v.kind as CategoryKind,
            parentId: v.parentId || null,
          });
          await refresh();
          toast(item ? 'Category updated' : 'Category added');
        }}
      />
    );
  }

  if (modal.kind === 'method') {
    const item = modal.item;
    const accountOptions = accounts.map((a) => ({ value: a.id, label: a.name }));
    return (
      <FieldsModal
        title={item ? 'Edit payment method' : 'Add payment method'}
        close={close}
        fields={[
          { key: 'name', label: 'Payment method', required: true },
          {
            key: 'accountId',
            label: 'Account',
            type: 'select',
            options: accountOptions,
            required: true,
            defaultValue: item?.account_id || '',
          },
        ]}
        initial={item ? { name: item.name, accountId: item.account_id } : undefined}
        onSave={async (v) => {
          await api.savePaymentMethod(item?.id || null, { name: v.name, accountId: v.accountId });
          await refresh();
          toast(item ? 'Method updated' : 'Method added');
        }}
      />
    );
  }

  if (modal.kind === 'payee') {
    const item = modal.item;
    return (
      <FieldsModal
        title={item ? 'Edit payee' : 'Add payee'}
        close={close}
        fields={[
          { key: 'name', label: 'Name', required: true },
          { key: 'address', label: 'Address', defaultValue: '' },
        ]}
        initial={item ? { name: item.name, address: item.address } : undefined}
        onSave={async (v) => {
          await api.savePayee(item?.id || null, { name: v.name, address: v.address });
          await refresh();
          toast(item ? 'Payee updated' : 'Payee added');
        }}
      />
    );
  }

  if (modal.kind === 'tag') {
    const item = modal.item;
    return (
      <FieldsModal
        title={item ? 'Edit tag' : 'Add tag'}
        close={close}
        fields={[{ key: 'name', label: 'Tag name', required: true }]}
        initial={item ? { name: item.name } : undefined}
        onSave={async (v) => {
          await api.saveTag(item?.id || null, { name: v.name });
          await refresh();
          toast(item ? 'Tag updated' : 'Tag added');
        }}
      />
    );
  }

  return null;
}
