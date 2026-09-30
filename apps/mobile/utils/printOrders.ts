import type {
  CookbookPrintFulfillmentStatus,
  CookbookPrintMoney,
  CookbookPrintOrder,
  CookbookPrintPaymentStatus,
} from '@/types/types';

export type PrintStatusTone = 'green' | 'gold' | 'red' | 'quiet';

const fulfillmentLabels: Record<CookbookPrintFulfillmentStatus, string> = {
  'awaiting-payment': 'Awaiting payment',
  submitting: 'Sending to printer',
  'submission-failed': 'Needs attention',
  'submission-unknown': 'Checking with printer',
  submitted: 'Accepted by printer',
  'in-production': 'In production',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  'reprint-requested': 'Reprint requested',
  reprinting: 'Reprinting',
  failed: 'Needs attention',
};

const paymentLabels: Record<CookbookPrintPaymentStatus, string> = {
  'requires-payment': 'Payment required',
  processing: 'Payment processing',
  paid: 'Paid',
  'refund-pending': 'Refund pending',
  refunded: 'Refunded',
  failed: 'Payment failed',
};

export function printFulfillmentLabel(status: CookbookPrintFulfillmentStatus): string {
  return fulfillmentLabels[status];
}

export function printPaymentLabel(status: CookbookPrintPaymentStatus): string {
  return paymentLabels[status];
}

export function printOrderTone(order: CookbookPrintOrder): PrintStatusTone {
  if (order.fulfillmentStatus === 'delivered' || order.fulfillmentStatus === 'shipped' || order.fulfillmentStatus === 'in-production') return 'green';
  if (order.fulfillmentStatus === 'cancelled' || order.paymentStatus === 'refunded') return 'quiet';
  if (order.fulfillmentStatus === 'submission-failed' || order.fulfillmentStatus === 'failed' || order.paymentStatus === 'failed') return 'red';
  return 'gold';
}

export function formatPrintMoney(money: CookbookPrintMoney): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: money.currency,
    }).format(money.amountMinor / 100);
  } catch {
    return `${money.currency} ${(money.amountMinor / 100).toFixed(2)}`;
  }
}

export function formatPrintDate(value: string, includeTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}

export function canCancelPrintOrder(order: CookbookPrintOrder): boolean {
  // Once the printer has accepted the job (`submitted`), the public Lulu API
  // exposes no safe cancellation mutation. The server remains authoritative
  // for races while a submission is still in flight.
  return order.fulfillmentStatus === 'awaiting-payment';
}

export function canRetryPrintOrder(order: CookbookPrintOrder): boolean {
  return ['submission-failed', 'submission-unknown'].includes(order.fulfillmentStatus)
    && !!order.lastFailure?.retryable;
}

export function canReprintCookbookOrder(order: CookbookPrintOrder): boolean {
  return order.fulfillmentStatus === 'shipped' || order.fulfillmentStatus === 'delivered';
}

export function isPrintOrderSettled(order: CookbookPrintOrder): boolean {
  if (order.paymentStatus === 'refund-pending') return false;

  return ['delivered', 'cancelled', 'failed'].includes(order.fulfillmentStatus)
    || order.paymentStatus === 'refunded';
}
