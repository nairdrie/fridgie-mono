import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { CookbookPrintService, sanitizePrintAddress } from '../utils/cookbookPrintService';
import type { PaymentGateway } from '../utils/cookbookPrintPayment';
import type { PrintProvider, ProviderOrderResult } from '../utils/cookbookPrintProvider';
import { selectOrdersForReconciliation, type StoredOrder } from '../utils/cookbookPrintStore';
import { COOKBOOK_PRINT_LAYOUT_VERSION, cookbookPrintHash, quoteBinding } from '../utils/cookbookPrint';

const NOW = new Date('2026-09-29T15:00:00.000Z');

function order(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'order_1111111111111111111111111111', ownerUid: 'owner', checkoutKey: 'checkout-key', quoteBinding: 'binding',
    draftId: 'draft', snapshotId: 'snapshot', quoteId: 'quote', title: 'Kitchen Keepsakes', sku: 'matte-softcover', quantity: 1,
    total: { amountMinor: 3200, currency: 'CAD' }, paymentStatus: 'processing', fulfillmentStatus: 'submitted',
    provider: 'lulu', providerName: 'Lulu Press, Inc.', providerOrderId: '4321',
    address: { name: 'Ada', line1: '1 Main', city: 'Toronto', stateOrProvince: 'ON', postalCode: 'M5V 2T6', country: 'CA', phone: '+14165550123' },
    shippingLevel: 'MAIL', stripePaymentIntentId: 'pi_fixture', contactEmail: 'ada@example.test',
    artifacts: {
      interiorPath: 'private/interior.pdf', coverPath: 'private/cover.pdf', previewPagePaths: [],
      interiorSha256: '1'.repeat(64), coverSha256: '2'.repeat(64), interiorMd5: '1'.repeat(32), coverMd5: '2'.repeat(32),
      pageCount: 32, deleteAfter: '2027-01-01T00:00:00.000Z',
    },
    acknowledgements: { rightsConfirmedAt: NOW.toISOString(), reviewedEveryPageAt: NOW.toISOString(), providerConsentAt: NOW.toISOString(), policyVersion: 1 },
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function providerResult(status: string, providerOrderId = '4321'): ProviderOrderResult {
  return { providerOrderId, status, raw: { id: providerOrderId, status } };
}

function harness(initial: StoredOrder, providerOverrides: Partial<PrintProvider> = {}, event?: Stripe.Event, paymentOverrides: Partial<PaymentGateway> = {}) {
  let current = initial;
  const patches: Array<Partial<StoredOrder>> = [];
  let captures = 0;
  let reversals = 0;
  let taxAssociationLookups = 0;
  const store = {
    updateOrder: async (_id: string, patch: Partial<StoredOrder>) => {
      patches.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    queueAuthorizedSubmission: async (_id: string) => {
      const patch: Partial<StoredOrder> = { paymentStatus: 'processing', fulfillmentStatus: 'submitting', submitLeaseUntil: undefined };
      patches.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    markWebhookOnce: async () => true,
    webhookProcessed: async () => false,
    releaseWebhook: async () => {},
    getOrder: async (_uid: string, id: string) => id === current.id ? current : null,
    getOrderById: async (id: string) => id === current.id ? current : null,
    findOrderByPaymentIntent: async () => current,
    findOrderByProviderId: async () => null,
    findOrderByReprintExternalId: async (externalId: string) => externalId === current.reprintExternalId ? current : null,
    claimSubmission: async () => current,
    claimCancellation: async () => current.fulfillmentStatus === 'awaiting-payment' ? current : null,
  };
  const provider: PrintProvider = {
    id: 'lulu', name: 'Lulu Press, Inc.',
    quote: async () => { throw new Error('unused'); },
    submit: async () => providerResult('CREATED'),
    getOrder: async () => providerResult('CREATED'),
    findByExternalId: async () => null,
    coverGeometry: async () => undefined,
    verifyWebhook: () => true,
    ...providerOverrides,
  };
  const payments: PaymentGateway = {
    publishableKey: 'pk_test_fixture',
    createAuthorization: async () => { throw new Error('unused'); },
    retrieve: async intentId => ({
      id: intentId,
      clientSecret: 'pi_fixture_secret_fixture',
      status: event?.type === 'payment_intent.succeeded' ? 'succeeded'
        : event?.type === 'payment_intent.amount_capturable_updated' ? 'requires_capture'
          : event?.type === 'payment_intent.payment_failed' ? 'requires_payment_method'
            : event?.type === 'payment_intent.canceled' ? 'canceled'
              : 'requires_payment_method',
    }),
    capture: async () => { captures += 1; return 'succeeded'; },
    cancel: async () => { reversals += 1; return { status: 'refund-pending', refundId: 're_fixture' }; },
    refund: async () => 're_fixture',
    calculateTax: async () => { throw new Error('unused'); },
    findTaxAssociation: async () => { taxAssociationLookups += 1; return { calculationId: 'taxcalc_fixture', transactionId: 'tax_tx_fixture' }; },
    verifyWebhook: async () => event!,
    ...paymentOverrides,
  };
  const service = new CookbookPrintService({
    store: store as any, provider, payments: () => payments,
    cookbook: async () => [], account: async () => ({}), now: () => NOW,
  });
  return {
    service, patches, store,
    get captures() { return captures; }, get reversals() { return reversals; },
    get taxAssociationLookups() { return taxAssociationLookups; },
  };
}

describe('cookbook print webhook state hardening', () => {
  test('validates carrier phone and subdivision codes before any provider call', () => {
    expect(sanitizePrintAddress(order().address)).toMatchObject({ stateOrProvince: 'ON', phone: '+14165550123' });
    expect(() => sanitizePrintAddress({ ...(order().address as any), stateOrProvince: 'Ontario' })).toThrow('2- or 3-letter');
    expect(() => sanitizePrintAddress({ ...(order().address as any), phone: '123' })).toThrow('8-20');
  });

  test('does not regress a shipped order when an older CREATED status arrives', async () => {
    const test = harness(order({ fulfillmentStatus: 'shipped', paymentStatus: 'paid' }));
    await (test.service as any).applyProviderStatus(order({ fulfillmentStatus: 'shipped', paymentStatus: 'paid' }), providerResult('CREATED'), 'stale');
    expect(test.patches.at(-1)).toMatchObject({ providerStatus: 'CREATED' });
    expect(test.patches.at(-1)?.fulfillmentStatus).toBeUndefined();
    expect(test.captures).toBe(0);
  });

  test('captures once on an accepted original job but never refunds the original payment for a failed replacement', async () => {
    const acceptedOrder = order({ fulfillmentStatus: 'submitted', paymentStatus: 'processing' });
    const accepted = harness(acceptedOrder);
    await (accepted.service as any).applyProviderStatus(acceptedOrder, providerResult('IN_PRODUCTION'), 'accepted');
    expect(accepted.captures).toBe(1);
    expect(accepted.patches.at(-1)).toMatchObject({ fulfillmentStatus: 'in-production', paymentStatus: 'paid' });

    const replacementOrder = order({ fulfillmentStatus: 'reprinting', paymentStatus: 'paid', reprintAttempt: 1, reprintExternalId: 'replacement-1' });
    const replacement = harness(replacementOrder);
    await (replacement.service as any).applyProviderStatus(replacementOrder, providerResult('REJECTED', 'replacement-provider-id'), 'replacement-failed');
    expect(replacement.reversals).toBe(0);
    expect(replacement.patches.at(-1)).toMatchObject({ fulfillmentStatus: 'failed' });
    expect(replacement.patches.at(-1)?.paymentStatus).toBeUndefined();
  });

  test('accepts a canonical delivered jump during outage recovery and captures the original authorization', async () => {
    const interrupted = order({ fulfillmentStatus: 'submission-unknown', paymentStatus: 'processing', providerOrderId: undefined });
    const test = harness(interrupted);
    await (test.service as any).applyProviderStatus(interrupted, providerResult('DELIVERED', '9876'), 'delivered-recovery');
    expect(test.captures).toBe(1);
    expect(test.patches.at(-1)).toMatchObject({ providerOrderId: '9876', fulfillmentStatus: 'delivered', paymentStatus: 'paid' });
  });

  test('queues authorized payment durably without calling Lulu in the Stripe webhook request', async () => {
    const awaiting = order({ fulfillmentStatus: 'awaiting-payment', paymentStatus: 'requires-payment', providerOrderId: undefined });
    let providerCalls = 0;
    const event = {
      id: 'evt_authorized', type: 'payment_intent.amount_capturable_updated',
      data: { object: { object: 'payment_intent', id: awaiting.stripePaymentIntentId, metadata: { order_id: awaiting.id } } },
    } as unknown as Stripe.Event;
    const test = harness(awaiting, {
      findByExternalId: async () => { providerCalls += 1; return null; },
      submit: async () => { providerCalls += 1; return providerResult('CREATED'); },
    }, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(providerCalls).toBe(0);
    expect(test.patches.at(-1)).toMatchObject({ paymentStatus: 'processing', fulfillmentStatus: 'submitting' });
  });

  test('recovers an ambiguous Lulu job by external id and attaches its canonical provider id', async () => {
    const ambiguous = order({ fulfillmentStatus: 'submission-unknown', providerOrderId: undefined });
    const recovered = providerResult('IN_PRODUCTION', '9876');
    const test = harness(ambiguous, { findByExternalId: async id => id === ambiguous.id ? recovered : null });
    await test.service.handleLuluWebhook(JSON.stringify({ external_id: ambiguous.id, id: 9876 }), 'valid');
    expect(test.patches.at(-1)).toMatchObject({ providerOrderId: '9876', providerStatus: 'IN_PRODUCTION', fulfillmentStatus: 'in-production' });
  });

  test('recovers an expired in-flight submission before considering another provider POST', async () => {
    const inFlight = order({ fulfillmentStatus: 'submitting', providerOrderId: undefined });
    const recovered = providerResult('IN_PRODUCTION', '9876');
    let submissions = 0;
    const test = harness(inFlight, {
      findByExternalId: async id => id === inFlight.id ? recovered : null,
      submit: async () => { submissions += 1; return providerResult('CREATED'); },
    });
    await test.service.reconcileOrder(inFlight.id);
    expect(submissions).toBe(0);
    expect(test.patches.at(-1)).toMatchObject({ providerOrderId: '9876', fulfillmentStatus: 'in-production' });
  });

  test('treats every retryable provider submission failure as ambiguous', async () => {
    const authorized = order({ fulfillmentStatus: 'awaiting-payment', providerOrderId: undefined });
    const providerError = Object.assign(new Error('connection reset after write'), { code: 'LULU_UNAVAILABLE', retryable: true });
    const test = harness(authorized, {
      findByExternalId: async () => null,
      submit: async () => { throw providerError; },
    });
    await test.service.submitAuthorizedOrder(authorized.id);
    expect(test.patches.at(-1)).toMatchObject({ fulfillmentStatus: 'submission-unknown' });
    expect(test.reversals).toBe(0);
  });

  test('reconciliation finishes an interrupted payment reversal without retrying a terminal provider rejection', async () => {
    const terminal = order({
      fulfillmentStatus: 'submission-failed', providerOrderId: undefined,
      lastFailure: { code: 'LULU_REJECTED', message: 'rejected', retryable: false },
    });
    let cancelAttempts = 0;
    let cancelUnavailable = true;
    let providerCalls = 0;
    const test = harness(terminal, {
      findByExternalId: async () => { providerCalls += 1; return null; },
      submit: async () => { providerCalls += 1; return providerResult('CREATED'); },
    }, undefined, {
      cancel: async () => {
        cancelAttempts += 1;
        if (cancelUnavailable) throw Object.assign(new Error('Stripe unavailable'), { code: 'STRIPE_UNAVAILABLE' });
        return { status: 'canceled' };
      },
    });
    await expect((test.service as any).reverseTerminalProviderFailure(terminal)).rejects.toMatchObject({ code: 'STRIPE_UNAVAILABLE' });
    cancelUnavailable = false;
    await test.service.reconcileOrder(terminal.id);
    expect(providerCalls).toBe(0);
    expect(cancelAttempts).toBe(2);
    expect(test.patches.at(-1)).toMatchObject({ paymentStatus: 'failed', fulfillmentStatus: 'failed' });
  });

  test('resolves replacement webhooks by their replacement external id', async () => {
    const replacement = order({
      fulfillmentStatus: 'reprinting', paymentStatus: 'paid', providerOrderId: undefined,
      reprintAttempt: 1, reprintExternalId: 'order_1111111111111111111111111111-reprint-1',
    });
    const recovered = providerResult('IN_PRODUCTION', 'replacement-provider-id');
    const test = harness(replacement, {
      findByExternalId: async id => id === replacement.reprintExternalId ? recovered : null,
    });
    await test.service.handleLuluWebhook(JSON.stringify({ external_id: replacement.reprintExternalId, id: 'replacement-provider-id' }), 'valid');
    expect(test.patches.at(-1)).toMatchObject({ providerOrderId: 'replacement-provider-id', fulfillmentStatus: 'in-production' });
  });

  test('ignores a late original-job webhook after a replacement claim', async () => {
    const replacement = order({
      fulfillmentStatus: 'reprinting', paymentStatus: 'paid', providerOrderId: undefined,
      reprintAttempt: 1, reprintExternalId: 'order_1111111111111111111111111111-reprint-1',
      priorProviderOrderIds: ['4321'],
    });
    let providerReads = 0;
    const test = harness(replacement, {
      findByExternalId: async () => { providerReads += 1; return null; },
      getOrder: async () => { providerReads += 1; return providerResult('DELIVERED', '4321'); },
    });
    await test.service.handleLuluWebhook(JSON.stringify({ external_id: replacement.id, id: '4321' }), 'valid');
    expect(providerReads).toBe(0);
    expect(test.patches).toHaveLength(0);
  });

  test('refuses automatic cancellation once provider submission may have started', async () => {
    const ambiguous = order({ fulfillmentStatus: 'submission-unknown', providerOrderId: undefined });
    const test = harness(ambiguous);
    await expect(test.service.cancelOrder(ambiguous.ownerUid, ambiguous.id)).rejects.toMatchObject({ code: 'ORDER_NOT_CANCELABLE' });
    expect(test.reversals).toBe(0);
  });

  test('never presents a PaymentIntent again after the durable cancellation fence is written', async () => {
    const uid = 'owner';
    const checkoutKey = 'checkout-fenced';
    const address = { name: 'Ada', line1: '1 Main', city: 'Toronto', stateOrProvince: 'ON', postalCode: 'M5V 2T6', country: 'CA', phone: '+14165550123' };
    const normalizedAddress = sanitizePrintAddress(address);
    const addressDigest = cookbookPrintHash({ ...normalizedAddress, name: 'ada', line1: '1 main', city: 'toronto', postalCode: 'M5V2T6' });
    const quote = {
      id: 'quote-fenced', draftId: 'draft', sku: 'matte-softcover', quantity: 1,
      printing: { amountMinor: 2400, currency: 'CAD' }, shipping: { amountMinor: 800, currency: 'CAD' },
      tax: { amountMinor: 0, currency: 'CAD' }, discount: { amountMinor: 0, currency: 'CAD' },
      total: { amountMinor: 3200, currency: 'CAD' }, taxStatus: 'unavailable', shippingMethod: 'MAIL',
      provider: 'lulu', providerName: 'Lulu Press, Inc.', createdAt: NOW.toISOString(), expiresAt: '2026-09-29T15:30:00.000Z',
      ownerUid: uid, snapshotId: 'snapshot', snapshotHash: 'snapshot-hash', addressHash: addressDigest, address: normalizedAddress,
    } as any;
    const binding = quoteBinding(quote, addressDigest, quote.snapshotHash);
    const orderId = `order_${cookbookPrintHash({ uid, checkoutKey }).slice(0, 28)}`;
    const fenced = order({ id: orderId, quoteBinding: binding, checkoutKey, cancellationRequestedAt: NOW.toISOString(), fulfillmentStatus: 'awaiting-payment', paymentStatus: 'requires-payment', providerOrderId: undefined });
    const test = harness(fenced);
    (test.store as any).getDraft = async () => ({
      id: 'draft', ownerUid: uid, revision: 1, status: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      title: 'Kitchen Keepsakes', subtitle: '', dedication: '', byline: 'Ada', theme: 'classic', sku: 'matte-softcover',
      coverCrop: { x: 0.5, y: 0.5, zoom: 1 }, includeTableOfContents: true, includeIndex: true, recipes: [],
      render: { revision: 1, layoutVersion: COOKBOOK_PRINT_LAYOUT_VERSION, snapshotId: 'snapshot', contentHash: 'snapshot-hash', artifacts: fenced.artifacts, issues: [], spineWidthInches: 0.1, pages: [], createdAt: NOW.toISOString() },
    });
    (test.store as any).getQuote = async () => quote;
    await expect(test.service.checkout(uid, 'draft', {
      quoteId: quote.id, address, checkoutKey,
      rightsConfirmed: true, reviewedEveryPage: true, providerConsent: true,
    })).rejects.toMatchObject({ code: 'ORDER_CANCELLATION_PENDING', status: 409 });
  });

  test('ignores a late authorization event after payment is already paid', async () => {
    const paid = order({ fulfillmentStatus: 'shipped', paymentStatus: 'paid' });
    const event = {
      id: 'evt_stale', type: 'payment_intent.amount_capturable_updated',
      data: { object: { object: 'payment_intent', id: paid.stripePaymentIntentId, metadata: { order_id: paid.id } } },
    } as unknown as Stripe.Event;
    const test = harness(paid, {}, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches).toHaveLength(0);
  });

  test('uses canonical Stripe state to ignore a delayed failure after authorization', async () => {
    const authorized = order({ fulfillmentStatus: 'submitting', paymentStatus: 'processing' });
    const event = {
      id: 'evt_old_failure', type: 'payment_intent.payment_failed',
      data: { object: { object: 'payment_intent', id: authorized.stripePaymentIntentId, metadata: { order_id: authorized.id } } },
    } as unknown as Stripe.Event;
    const test = harness(authorized, {}, event, {
      retrieve: async intentId => ({ id: intentId, clientSecret: 'secret', status: 'requires_capture' }),
    });
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches).toHaveLength(0);
  });

  test('keeps tracking an uncancellable provider job after a canonical Stripe failure', async () => {
    const submitted = order({ fulfillmentStatus: 'in-production', paymentStatus: 'processing', submitAttempt: 1 });
    const event = {
      id: 'evt_capture_failure', type: 'payment_intent.payment_failed',
      data: { object: { object: 'payment_intent', id: submitted.stripePaymentIntentId, metadata: { order_id: submitted.id } } },
    } as unknown as Stripe.Event;
    const test = harness(submitted, {}, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches.at(-1)).toMatchObject({
      paymentStatus: 'failed', fulfillmentStatus: 'in-production',
      lastFailure: { code: 'PAYMENT_FAILED_AFTER_SUBMISSION' },
    });
  });

  test('does not label an uncancellable Lulu job cancelled when Stripe cancels payment', async () => {
    const submitted = order({ fulfillmentStatus: 'submitted', paymentStatus: 'processing', submitAttempt: 1 });
    const event = {
      id: 'evt_canceled_after_submit', type: 'payment_intent.canceled',
      data: { object: { object: 'payment_intent', id: submitted.stripePaymentIntentId, metadata: { order_id: submitted.id } } },
    } as unknown as Stripe.Event;
    const test = harness(submitted, {}, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches.at(-1)).toMatchObject({
      paymentStatus: 'failed', fulfillmentStatus: 'submitted',
      lastFailure: { code: 'PAYMENT_CANCELED_AFTER_SUBMISSION' },
    });
  });

  test('treats even a lease-free submitting queue as ambiguous during payment cancellation', async () => {
    const queued = order({
      fulfillmentStatus: 'submitting', paymentStatus: 'processing', providerOrderId: undefined,
      submitAttempt: undefined, submitLeaseUntil: undefined,
    });
    const event = {
      id: 'evt_canceled_while_claiming', type: 'payment_intent.canceled',
      data: { object: { object: 'payment_intent', id: queued.stripePaymentIntentId, metadata: { order_id: queued.id } } },
    } as unknown as Stripe.Event;
    const test = harness(queued, {}, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches.at(-1)).toMatchObject({
      paymentStatus: 'failed', fulfillmentStatus: 'submitting',
      lastFailure: { code: 'PAYMENT_CANCELED_AFTER_SUBMISSION' },
    });
  });

  test('does not let a delayed succeeded event reopen a refunded payment', async () => {
    const refunded = order({ fulfillmentStatus: 'cancelled', paymentStatus: 'refunded', stripeRefundStatus: 'succeeded' });
    const event = {
      id: 'evt_old_success', type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', id: refunded.stripePaymentIntentId, metadata: { order_id: refunded.id } } },
    } as unknown as Stripe.Event;
    const test = harness(refunded, {}, event);
    await test.service.handleStripeWebhook('{}', 'valid');
    expect(test.patches).toHaveLength(0);
  });

  test('records Stripe-managed tax only on successful payment and leaves refund reversal ownership with Stripe', async () => {
    const payable = order({ paymentStatus: 'processing', stripeTaxCalculationId: 'taxcalc_fixture', stripeTaxStatus: 'pending' });
    const succeeded = {
      id: 'evt_paid', type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', id: payable.stripePaymentIntentId, metadata: { order_id: payable.id } } },
    } as unknown as Stripe.Event;
    const paid = harness(payable, {}, succeeded);
    await paid.service.handleStripeWebhook('{}', 'valid');
    expect(paid.taxAssociationLookups).toBe(1);
    expect(paid.patches.at(-1)).toMatchObject({ paymentStatus: 'paid', stripeTaxStatus: 'committed', stripeTaxTransactionId: 'tax_tx_fixture' });

    const refunding = order({ paymentStatus: 'refund-pending', stripeTaxCalculationId: 'taxcalc_fixture', stripeTaxStatus: 'committed', stripeTaxTransactionId: 'tax_tx_fixture', stripeRefundStatus: 'pending' });
    const refunded = {
      id: 'evt_refunded', type: 'charge.refunded',
      data: { object: { object: 'charge', id: 'ch_fixture', payment_intent: refunding.stripePaymentIntentId, refunded: true } },
    } as unknown as Stripe.Event;
    const reversed = harness(refunding, {}, refunded);
    await reversed.service.handleStripeWebhook('{}', 'valid');
    expect(reversed.taxAssociationLookups).toBe(0);
    expect(reversed.patches.at(-1)).toMatchObject({ paymentStatus: 'refunded', stripeRefundStatus: 'succeeded' });
  });

  test('returns to paid when an asynchronous refund fails and ignores a stale refunded charge afterward', async () => {
    const refunding = order({ paymentStatus: 'refund-pending', stripeRefundStatus: 'pending', stripeRefundId: 're_fixture' });
    const failedEvent = {
      id: 'evt_refund_failed', type: 'refund.failed',
      data: { object: { object: 'refund', id: 're_fixture', payment_intent: refunding.stripePaymentIntentId, status: 'failed' } },
    } as unknown as Stripe.Event;
    const failed = harness(refunding, {}, failedEvent);
    await failed.service.handleStripeWebhook('{}', 'valid');
    expect(failed.patches.at(-1)).toMatchObject({ paymentStatus: 'paid', stripeRefundStatus: 'failed', stripeRefundId: 're_fixture' });

    const staleEvent = {
      id: 'evt_stale_refunded', type: 'charge.refunded',
      data: { object: { object: 'charge', id: 'ch_fixture', payment_intent: refunding.stripePaymentIntentId, refunded: true } },
    } as unknown as Stripe.Event;
    const stale = harness(order({ paymentStatus: 'paid', stripeRefundStatus: 'failed', stripeRefundId: 're_fixture' }), {}, staleEvent);
    await stale.service.handleStripeWebhook('{}', 'valid');
    expect(stale.patches).toHaveLength(0);
  });
});

describe('cookbook print reconciliation scheduling', () => {
  test('prioritizes queued authorizations and rotates fairly through long-lived orders', () => {
    const submitted = Array.from({ length: 150 }, (_, index) => order({
      id: `order_${String(index).padStart(28, '0')}`,
      fulfillmentStatus: 'submitted',
      updatedAt: new Date(NOW.getTime() + index).toISOString(),
    }));
    const queued = order({
      id: 'order_queued_authorization_000000', fulfillmentStatus: 'submitting',
      providerOrderId: undefined, submitLeaseUntil: undefined,
      lastReconciledAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    });
    const first = selectOrdersForReconciliation([...submitted, queued], 100);
    expect(first[0]?.id).toBe(queued.id);
    const reconciledAt = new Date(NOW.getTime() + 172_800_000).toISOString();
    const touched = new Set(first.map(item => item.id));
    const second = selectOrdersForReconciliation([...submitted, queued].map(item =>
      touched.has(item.id) ? { ...item, lastReconciledAt: reconciledAt } : item), 100);
    expect(second.some(item => item.id === submitted[149]!.id)).toBe(true);
  });
});
