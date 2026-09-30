import { describe, expect, test } from 'bun:test';
import {
  accountStatusFromUnknown,
  aiUsageFromUnknown,
  checkoutState,
  formatResetLabel,
  formatUsageSummary,
  isSecureWebUrl,
  isCurrentUsageWindowExhausted,
  quotaGateAfterRefresh,
  usageNotice,
} from './pro';

const validUsage = {
  used: 7,
  limit: 10,
  remaining: 3,
  windowStartsAt: '2026-09-28T00:00:00Z',
  windowEndsAt: '2026-10-05T00:00:00Z',
};

describe('aiUsageFromUnknown', () => {
  test('accepts a complete server snapshot and rejects malformed counters', () => {
    expect(aiUsageFromUnknown(validUsage)).toEqual(validUsage);
    expect(aiUsageFromUnknown({ ...validUsage, remaining: '3' })).toBeNull();
    expect(aiUsageFromUnknown({ ...validUsage, remaining: 11 })).toBeNull();
    expect(aiUsageFromUnknown({ ...validUsage, windowEndsAt: 'later' })).toBeNull();
  });
});

describe('accountStatusFromUnknown', () => {
  const valid = {
    plan: 'free',
    isPro: false,
    entitlement: {
      status: 'inactive',
      provider: 'revenuecat',
      expiresAt: null,
      verifiedAt: '2026-09-29T11:00:00Z',
      productIdentifier: null,
    },
    aiUsage: validUsage,
    leftoversScanUsage: null,
  };

  test('accepts a complete authoritative quota response', () => {
    expect(accountStatusFromUnknown({ error: 'ai_quota_exceeded', ...valid })).toEqual(valid);
  });

  test('rejects contradictory plans and partial or malformed snapshots', () => {
    expect(accountStatusFromUnknown({ ...valid, isPro: true })).toBeNull();
    expect(accountStatusFromUnknown({ ...valid, entitlement: undefined })).toBeNull();
    expect(accountStatusFromUnknown({ ...valid, aiUsage: { ...validUsage, remaining: '3' } })).toBeNull();
    expect(accountStatusFromUnknown({
      ...valid,
      entitlement: { ...valid.entitlement, status: 'active' },
    })).toBeNull();
    expect(accountStatusFromUnknown({
      ...valid,
      entitlement: { ...valid.entitlement, provider: 'revenuecat', verifiedAt: 'not-a-date' },
    })).toBeNull();
    expect(accountStatusFromUnknown({ ...valid, leftoversScanUsage: undefined })).toBeNull();
  });
});

describe('quotaGateAfterRefresh', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const status = {
    plan: 'free' as const,
    isPro: false,
    entitlement: {
      status: 'inactive' as const,
      provider: 'revenuecat' as const,
      expiresAt: null,
      verifiedAt: '2026-09-29T11:00:00Z',
      productIdentifier: null,
    },
    aiUsage: { ...validUsage, used: 10, remaining: 0 },
    leftoversScanUsage: null,
  };

  test('never hard-blocks from a cached zero when its refresh failed', () => {
    expect(quotaGateAfterRefresh(null, 'suggestions', now)).toEqual({ kind: 'allow' });
  });

  test('blocks only a current fresh zero and lets the server decide after reset', () => {
    expect(quotaGateAfterRefresh(status, 'suggestions', now)).toMatchObject({
      kind: 'quota-exhausted',
      isPro: false,
    });
    expect(quotaGateAfterRefresh({
      ...status,
      aiUsage: { ...status.aiUsage, windowEndsAt: '2026-09-29T11:59:59Z' },
    }, 'suggestions', now)).toEqual({ kind: 'allow' });
    expect(quotaGateAfterRefresh({
      ...status,
      aiUsage: { ...status.aiUsage, used: 9, remaining: 1 },
    }, 'suggestions', now)).toEqual({ kind: 'allow' });
  });

  test('distinguishes a verified downgrade from unavailable scan verification', () => {
    expect(quotaGateAfterRefresh(status, 'leftovers', now)).toEqual({ kind: 'pro-required' });
    expect(quotaGateAfterRefresh({
      ...status,
      entitlement: { ...status.entitlement, status: 'unavailable' },
    }, 'leftovers', now)).toEqual({ kind: 'allow' });
  });
});

describe('formatResetLabel', () => {
  const zone = 'America/Toronto';

  test('uses today and tomorrow instead of a surprising timestamp', () => {
    const now = new Date('2026-09-29T14:00:00-04:00');
    expect(formatResetLabel('2026-09-29T20:30:00-04:00', now, 'en-US', zone))
      .toBe('Resets today at 8:30 PM');
    expect(formatResetLabel('2026-09-30T08:00:00-04:00', now, 'en-US', zone))
      .toBe('Resets tomorrow at 8:00 AM');
  });

  test('names the weekday for a reset later this week', () => {
    const now = new Date('2026-09-29T14:00:00-04:00');
    expect(formatResetLabel('2026-10-03T09:00:00-04:00', now, 'en-US', zone))
      .toBe('Resets Saturday at 9:00 AM');
  });

  test('handles an expired boundary and invalid server data safely', () => {
    const now = new Date('2026-09-29T14:00:00-04:00');
    expect(formatResetLabel('2026-09-29T13:00:00-04:00', now, 'en-US', zone))
      .toBe('Resetting now');
    expect(formatResetLabel('not-a-date', now, 'en-US', zone))
      .toBe('Reset time unavailable');
  });
});

describe('formatUsageSummary', () => {
  test('pluralizes the remaining allowance', () => {
    expect(formatUsageSummary({
      used: 9,
      limit: 10,
      remaining: 1,
      windowStartsAt: '',
      windowEndsAt: '',
    })).toBe('1 of 10 AI meal suggestion left');
    expect(formatUsageSummary({
      used: 4,
      limit: 10,
      remaining: 6,
      windowStartsAt: '',
      windowEndsAt: '',
    })).toBe('6 of 10 AI meal suggestions left');
  });
});

describe('usageNotice', () => {
  const usage = (remaining: number) => ({
    used: 10 - remaining,
    limit: 10,
    remaining,
    windowStartsAt: '2026-09-27T00:00:00Z',
    windowEndsAt: '2026-10-04T00:00:00Z',
  });

  test('escalates free warnings at three, one, and zero remaining', () => {
    const now = new Date('2026-09-29T14:00:00-04:00');
    expect(usageNotice(usage(3), false, now).level).toBe('low');
    expect(usageNotice(usage(3), false, now).title).toBe('3 free suggestions remaining this week');
    expect(usageNotice(usage(2), false, now).title).toBe('2 free suggestions remaining this week');
    expect(usageNotice(usage(1), false, now).level).toBe('critical');
    expect(usageNotice(usage(1), false, now).title).toBe('1 free suggestion remaining this week');
    expect(usageNotice(usage(0), false, now).level).toBe('exhausted');
  });

  test('warns a Pro user when the fair-use balance is nearly gone', () => {
    const pro = { ...usage(3), used: 97, limit: 100 };
    expect(usageNotice(pro, true)).toMatchObject({
      level: 'low',
      title: '3 AI suggestions remaining this week',
    });
  });
});

describe('isCurrentUsageWindowExhausted', () => {
  const exhausted = {
    used: 10,
    limit: 10,
    remaining: 0,
    windowStartsAt: '2026-09-20T00:00:00Z',
    windowEndsAt: '2026-09-27T00:00:00Z',
  };

  test('does not let an expired or invalid cached zero block a new request', () => {
    expect(isCurrentUsageWindowExhausted(exhausted, new Date('2026-09-26T23:59:59Z'))).toBe(true);
    expect(isCurrentUsageWindowExhausted(exhausted, new Date('2026-09-27T00:00:00Z'))).toBe(false);
    expect(isCurrentUsageWindowExhausted({ ...exhausted, windowEndsAt: 'invalid' })).toBe(false);
    expect(isCurrentUsageWindowExhausted({ ...exhausted, remaining: 1 })).toBe(false);
  });
});

describe('checkoutState', () => {
  const ready = {
    requiresAccount: false,
    billingConfigured: true,
    legalConfigured: true,
    entitlementStatus: 'inactive' as const,
    hasStatusError: false,
    hasSelectedOffer: true,
  };

  test('only enables checkout with identity, verification, and a store offer', () => {
    expect(checkoutState(ready)).toBe('ready');
    expect(checkoutState({ ...ready, requiresAccount: true })).toBe('sign-in-required');
    expect(checkoutState({ ...ready, billingConfigured: false })).toBe('billing-unconfigured');
    expect(checkoutState({ ...ready, legalConfigured: false })).toBe('legal-unconfigured');
    expect(checkoutState({ ...ready, entitlementStatus: 'unavailable' })).toBe('verification-unavailable');
    expect(checkoutState({ ...ready, hasStatusError: true })).toBe('status-error');
    expect(checkoutState({ ...ready, entitlementStatus: undefined })).toBe('status-pending');
    expect(checkoutState({ ...ready, hasSelectedOffer: false })).toBe('offer-unavailable');
  });

  test('sign-in takes priority so guests get an actionable paywall state', () => {
    expect(checkoutState({
      requiresAccount: true,
      billingConfigured: false,
      entitlementStatus: undefined,
      hasStatusError: true,
      hasSelectedOffer: false,
    })).toBe('sign-in-required');
  });
});

describe('isSecureWebUrl', () => {
  test('accepts only complete HTTPS legal destinations', () => {
    expect(isSecureWebUrl('https://fridgie.app/privacy')).toBe(true);
    expect(isSecureWebUrl('http://fridgie.app/privacy')).toBe(false);
    expect(isSecureWebUrl('fridgie.app/privacy')).toBe(false);
    expect(isSecureWebUrl('not a url')).toBe(false);
    expect(isSecureWebUrl('')).toBe(false);
  });
});
