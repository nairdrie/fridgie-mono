import { describe, expect, test } from 'bun:test';
import type { CookbookPrintOrder } from '@/types/types';
import { isPrintOrderSettled } from './printOrders';

const order = (
  fulfillmentStatus: CookbookPrintOrder['fulfillmentStatus'],
  paymentStatus: CookbookPrintOrder['paymentStatus'],
): CookbookPrintOrder => ({
  id: 'order-1',
  draftId: 'draft-1',
  snapshotId: 'snapshot-1',
  quoteId: 'quote-1',
  title: 'Family recipes',
  sku: 'matte-hardcover',
  quantity: 1,
  total: { amountMinor: 3000, currency: 'CAD' },
  paymentStatus,
  fulfillmentStatus,
  provider: 'lulu',
  providerName: 'Lulu',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});

describe('print order settlement', () => {
  test('keeps polling terminal fulfillment states while a refund is pending', () => {
    expect(isPrintOrderSettled(order('cancelled', 'refund-pending'))).toBe(false);
    expect(isPrintOrderSettled(order('failed', 'refund-pending'))).toBe(false);
  });

  test('settles terminal fulfillment states after payment is no longer refund-pending', () => {
    expect(isPrintOrderSettled(order('delivered', 'paid'))).toBe(true);
    expect(isPrintOrderSettled(order('cancelled', 'refunded'))).toBe(true);
    expect(isPrintOrderSettled(order('failed', 'failed'))).toBe(true);
  });

  test('settles any fulfillment state once the refund completes', () => {
    expect(isPrintOrderSettled(order('submitted', 'refunded'))).toBe(true);
  });
});
