import { describe, expect, test } from 'bun:test';
import { readDiscoverAdEntitlement, type DiscoverAdEntitlementAdapter, unavailableDiscoverAdEntitlementAdapter } from './entitlement';

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
});
