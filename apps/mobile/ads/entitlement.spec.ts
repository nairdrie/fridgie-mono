import { describe, expect, test } from 'bun:test';
import {
  discoverAdEntitlementFromPro,
  readDiscoverAdEntitlement,
  type DiscoverAdEntitlementAdapter,
  type ProDiscoverAdState,
  unavailableDiscoverAdEntitlementAdapter,
} from './entitlement';

const verifiedFree: ProDiscoverAdState = {
  isPro: false,
  isLoading: false,
  status: { isPro: false, entitlement: { status: 'inactive' } },
  statusError: null,
  verificationPending: false,
  isBillingStateLoading: false,
  action: null,
};

describe('Discover Pro entitlement adapter', () => {
  test('maps explicit free and Pro results without owning subscription logic', async () => {
    expect(await readDiscoverAdEntitlement({ getAdEntitlement: () => 'ad-supported' })).toBe('ad-supported');
    expect(await readDiscoverAdEntitlement({ getAdEntitlement: async () => 'ad-free' })).toBe('ad-free');
  });

  test('missing, invalid, and failed integrations suppress ads as unknown', async () => {
    expect(await readDiscoverAdEntitlement(unavailableDiscoverAdEntitlementAdapter)).toBe('unknown');
    expect(await readDiscoverAdEntitlement({ getAdEntitlement: () => 'invalid' as never })).toBe('unknown');
    const failed: DiscoverAdEntitlementAdapter = { getAdEntitlement: async () => { throw new Error('subscription unavailable'); } };
    expect(await readDiscoverAdEntitlement(failed)).toBe('unknown');
  });

  test('only a settled server-verified Free account is ad-supported', () => {
    expect(discoverAdEntitlementFromPro(verifiedFree)).toBe('ad-supported');
    expect(discoverAdEntitlementFromPro({
      ...verifiedFree,
      isPro: true,
      status: { isPro: true, entitlement: { status: 'active' } },
    })).toBe('ad-free');

    const ambiguous: ProDiscoverAdState[] = [
      { ...verifiedFree, status: null },
      { ...verifiedFree, isLoading: true },
      { ...verifiedFree, statusError: 'offline' },
      { ...verifiedFree, verificationPending: true },
      { ...verifiedFree, isBillingStateLoading: true },
      { ...verifiedFree, action: 'restoring' },
      { ...verifiedFree, status: { isPro: false, entitlement: { status: 'unavailable' } } },
      { ...verifiedFree, isPro: true },
      { ...verifiedFree, status: { isPro: true, entitlement: { status: 'active' } } },
      { ...verifiedFree, status: { isPro: false, entitlement: { status: 'active' } } },
    ];
    for (const state of ambiguous) {
      expect(discoverAdEntitlementFromPro(state)).toBe('unknown');
    }
  });
});
