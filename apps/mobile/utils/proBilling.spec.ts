import { describe, expect, test } from 'bun:test';
import {
  billingIdentityMatches,
  configuredBillingPeriod,
  createSerialTaskQueue,
  isStorePaymentPending,
  parsePersistedPendingVerification,
  pendingKindAfterRestoreFailure,
  pendingVerificationBelongsTo,
  shouldClearPendingVerification,
} from './proBilling';

describe('RevenueCat billing identity guard', () => {
  test('accepts only the two explicitly configured subscription products', () => {
    expect(configuredBillingPeriod('fridgie_monthly', 'fridgie_monthly', 'fridgie_annual'))
      .toBe('monthly');
    expect(configuredBillingPeriod('fridgie_annual', 'fridgie_monthly', 'fridgie_annual'))
      .toBe('annual');
    expect(configuredBillingPeriod('another_monthly_plan', 'fridgie_monthly', 'fridgie_annual'))
      .toBeNull();
  });

  test('distinguishes a store approval wait from cancellation or failure', () => {
    expect(isStorePaymentPending({ code: 20 })).toBe(true);
    expect(isStorePaymentPending({ code: '20' })).toBe(true);
    expect(isStorePaymentPending({ code: '1' })).toBe(false);
    expect(isStorePaymentPending(new Error('pending'))).toBe(false);
  });

  test('hydrates only a known pending-verification recovery record', () => {
    expect(parsePersistedPendingVerification(
      JSON.stringify({ uid: 'user-a', kind: 'payment-approval' }),
    )).toEqual({ uid: 'user-a', kind: 'payment-approval' });
    expect(parsePersistedPendingVerification(
      JSON.stringify({ uid: 'user-a', kind: 'injected-kind' }),
    )).toBeNull();
    expect(parsePersistedPendingVerification('{broken')).toBeNull();
  });

  test('requires Firebase, reconciled, and SDK identities to be the same', () => {
    const matching = {
      expectedUid: 'user-b',
      currentUid: 'user-b',
      readyUid: 'user-b',
      sdkUid: 'user-b',
    };

    expect(billingIdentityMatches(matching)).toBe(true);
    expect(billingIdentityMatches({ ...matching, currentUid: 'user-a' })).toBe(false);
    expect(billingIdentityMatches({ ...matching, readyUid: null })).toBe(false);
    expect(billingIdentityMatches({ ...matching, sdkUid: 'user-a' })).toBe(false);
  });

  test('only the account that started a pending transaction can resolve it', () => {
    expect(pendingVerificationBelongsTo('user-a', 'user-a')).toBe(true);
    expect(pendingVerificationBelongsTo('user-a', 'user-b')).toBe(false);
    expect(pendingVerificationBelongsTo(null, 'user-a')).toBe(false);
  });

  test('a failed restore never downgrades a purchase-origin safety lock', () => {
    expect(pendingKindAfterRestoreFailure('payment-approval', 'restore-verification'))
      .toBe('payment-approval');
    expect(pendingKindAfterRestoreFailure('store-entitlement-verification', 'restore-account-changed'))
      .toBe('store-entitlement-verification');
    expect(pendingKindAfterRestoreFailure(null, 'restore-verification'))
      .toBe('restore-verification');
  });

  test('clears only for same-account Pro verification or an authoritative restore', () => {
    expect(shouldClearPendingVerification({
      pendingUid: 'user-a', verifiedUid: 'user-a', isPro: true, authoritativeRestore: false,
    })).toBe(true);
    expect(shouldClearPendingVerification({
      pendingUid: 'user-a', verifiedUid: 'user-a', isPro: false, authoritativeRestore: false,
    })).toBe(false);
    expect(shouldClearPendingVerification({
      pendingUid: 'user-a', verifiedUid: 'user-a', isPro: false, authoritativeRestore: true,
    })).toBe(true);
    expect(shouldClearPendingVerification({
      pendingUid: 'user-a', verifiedUid: 'user-a', isPro: false, authoritativeRestore: true,
      preserveOnNegativeRestore: true,
    })).toBe(false);
    expect(shouldClearPendingVerification({
      pendingUid: 'user-a', verifiedUid: 'user-b', isPro: true, authoritativeRestore: true,
    })).toBe(false);
  });
});

describe('RevenueCat native operation queue', () => {
  test('runs identity changes and checkout serially', async () => {
    const queue = createSerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.run(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  test('continues after an earlier operation rejects', async () => {
    const queue = createSerialTaskQueue();
    await expect(queue.run(async () => { throw new Error('store unavailable'); })).rejects.toThrow();
    await expect(queue.run(async () => 'reconciled')).resolves.toBe('reconciled');
  });
});
