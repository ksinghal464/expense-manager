import { signedMoney, fmtDateTime } from './lib';
import type { TxView } from '../shared/types';

export function TxRow({ t, onClick }: { t: TxView; onClick: () => void }) {
  const isIncome = t.transaction_type === 'income';
  const isRefund = !!t.refunds_transaction_id;
  return (
    <button className={`tx${isRefund ? ' refund' : ''}`} onClick={onClick}>
      <div className="avatar">
        {(t.description || t.payee_name || t.category_name || '?').charAt(0).toUpperCase()}
      </div>
      <div className="txmain">
        <strong>{t.description || t.payee_name || '(No description)'}</strong>
        <span>
          {t.category_name || 'Uncategorized'}
          {t.payee_name ? ` · ${t.payee_name}` : ''}
          {isRefund ? ' · Refund' : ''}
          {t.is_split_parent ? ' · Split' : ''}
        </span>
        <small>
          {fmtDateTime(t.occurred_at)} · {t.account_name}
          {t.payment_method_name ? ` · ${t.payment_method_name}` : ''}
          {t.tags && t.tags.length ? ` · #${t.tags.join(' #')}` : ''}
        </small>
      </div>
      <b className={isIncome ? 'positive' : ''}>
        {signedMoney(t.amount_minor, t.transaction_type)}
      </b>
    </button>
  );
}
