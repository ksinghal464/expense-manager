import { signedMoney, fmtDateTime, money } from './lib';
import type { TxView } from '../shared/types';

export function TxRow({
  t,
  onClick,
  onOpenRef,
  balance,
  balanceLabel,
}: {
  t: TxView;
  onClick: () => void;
  onOpenRef?: (id: string) => void;
  balance?: number;
  balanceLabel?: string;
}) {
  const isIncome = t.transaction_type === 'income';
  const isRefund = !!t.refunds_transaction_id;
  const hasRefunds = !isRefund && (t.refunded_minor || 0) > 0;
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
          {t.is_split_parent ? ' · Split' : ''}
        </span>
        {t.note && <span className="txnote">📝 {t.note}</span>}
        {isRefund && t.refunds_transaction_id && (
          <span
            className={`txreflink${onOpenRef ? ' clickable' : ''}`}
            onClick={
              onOpenRef
                ? (e) => {
                    e.stopPropagation();
                    onOpenRef(t.refunds_transaction_id!);
                  }
                : undefined
            }
          >
            ↩ Refund of {t.refund_of_description || 'expense'}
            {t.refund_of_amount_minor != null ? ` (${money(t.refund_of_amount_minor)})` : ''}
            {t.refund_of_occurred_at ? ` · ${fmtDateTime(t.refund_of_occurred_at)}` : ''}
            {t.refund_siblings_total != null && t.refund_of_amount_minor != null
              ? ` · ${money(t.refund_siblings_total)} of ${money(t.refund_of_amount_minor)} refunded so far`
              : ''}
          </span>
        )}
        {hasRefunds && (
          <span className="txrefbadge">
            ↩ Refunded {money(t.refunded_minor || 0)} · Net{' '}
            {money(t.amount_minor - (t.refunded_minor || 0))}
          </span>
        )}
        <small>
          {fmtDateTime(t.occurred_at)} · {t.account_name}
          {t.payment_method_name ? ` · ${t.payment_method_name}` : ''}
          {t.tags && t.tags.length ? ` · #${t.tags.join(' #')}` : ''}
        </small>
      </div>
      <div className="txamountcol">
        <b className={isIncome ? 'positive' : ''}>
          {signedMoney(t.amount_minor, t.transaction_type)}
        </b>
        {hasRefunds && (
          <small>
            Net {signedMoney(t.amount_minor - (t.refunded_minor || 0), t.transaction_type)}
          </small>
        )}
        {balance !== undefined && (
          <small>
            {balanceLabel || 'Bal'} {money(balance)}
          </small>
        )}
      </div>
    </button>
  );
}
