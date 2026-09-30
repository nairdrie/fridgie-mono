import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createRequirePro } from '../middleware/requirePro';
import {
  EntitlementService,
  EntitlementVerificationError,
  parseRevenueCatEntitlement,
  type EntitlementStore,
  type EntitlementVerifier,
  type ResolvedEntitlement,
  type VerifiedEntitlement,
} from '../utils/entitlements';

class MemoryEntitlementStore implements EntitlementStore {
  value: VerifiedEntitlement | null = null;
  async read() { return this.value ? { ...this.value } : null; }
  async write(_uid: string, value: VerifiedEntitlement) { this.value = { ...value }; }
}

const verifier = (
  configured: boolean,
  result: VerifiedEntitlement | Error,
): EntitlementVerifier => ({
  provider: 'revenuecat',
  configured,
  async verify() {
    if (result instanceof Error) throw result;
    return { ...result };
  },
});

const entitlement = (overrides: Partial<ResolvedEntitlement> = {}): ResolvedEntitlement => ({
  isPro: false,
  status: 'inactive',
  provider: 'revenuecat',
  expiresAt: null,
  verifiedAt: '2026-09-29T12:00:00.000Z',
  productIdentifier: null,
  ...overrides,
});

describe('RevenueCat entitlement verification', () => {
  test('recognizes active, expired, lifetime and missing entitlements', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(parseRevenueCatEntitlement({ subscriber: { entitlements: { pro: { expires_date: '2026-10-01T00:00:00Z', product_identifier: 'fridgie_pro_monthly' } } } }, 'pro', now)).toMatchObject({ active: true, productIdentifier: 'fridgie_pro_monthly' });
    expect(parseRevenueCatEntitlement({ subscriber: { entitlements: { pro: { expires_date: '2026-09-01T00:00:00Z' } } } }, 'pro', now).active).toBe(false);
    expect(parseRevenueCatEntitlement({ subscriber: { entitlements: { pro: { expires_date: null } } } }, 'pro', now).active).toBe(true);
    expect(parseRevenueCatEntitlement({ subscriber: { entitlements: {} } }, 'pro', now).active).toBe(false);
    expect(() => parseRevenueCatEntitlement({}, 'pro', now)).toThrow(EntitlementVerificationError);
  });

  test('keeps a subscriber active through RevenueCat billing grace period', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(parseRevenueCatEntitlement({
      subscriber: {
        entitlements: {
          pro: {
            expires_date: '2026-09-28T00:00:00Z',
            grace_period_expires_date: '2026-10-02T00:00:00Z',
            product_identifier: 'fridgie_pro_monthly',
          },
        },
      },
    }, 'pro', now)).toMatchObject({
      active: true,
      expiresAt: '2026-10-02T00:00:00.000Z',
    });
  });

  test('never promotes a purchase when the provider is unconfigured', async () => {
    const service = new EntitlementService(
      new MemoryEntitlementStore(),
      verifier(false, new EntitlementVerificationError('not_configured')),
      () => new Date('2026-09-29T12:00:00.000Z'),
    );
    expect(await service.resolve('user-1')).toMatchObject({ isPro: false, status: 'unavailable', provider: 'none' });
  });

  test('identifies a configured provider outage without granting Pro', async () => {
    const service = new EntitlementService(
      new MemoryEntitlementStore(),
      verifier(true, new EntitlementVerificationError('provider_unavailable')),
      () => new Date('2026-09-29T12:00:00.000Z'),
    );
    expect(await service.resolve('user-1')).toMatchObject({
      isPro: false,
      status: 'unavailable',
      provider: 'revenuecat',
    });
  });

  test('persists a server-verified purchase and reuses the fresh cache', async () => {
    const store = new MemoryEntitlementStore();
    let calls = 0;
    const verified: VerifiedEntitlement = { active: true, provider: 'revenuecat', expiresAt: '2026-10-29T12:00:00.000Z', verifiedAt: '2026-09-29T12:00:00.000Z', productIdentifier: 'monthly' };
    const provider: EntitlementVerifier = { provider: 'revenuecat', configured: true, async verify() { calls += 1; return verified; } };
    const service = new EntitlementService(store, provider, () => new Date('2026-09-29T12:00:00.000Z'));

    expect(await service.resolve('user-1')).toMatchObject({ isPro: true, status: 'active' });
    expect(await service.resolve('user-1')).toMatchObject({ isPro: true, status: 'active' });
    expect(calls).toBe(1);
    expect(store.value?.productIdentifier).toBe('monthly');
  });

  test('coalesces concurrent server verification for one account', async () => {
    const store = new MemoryEntitlementStore();
    let calls = 0;
    const provider: EntitlementVerifier = {
      provider: 'revenuecat',
      configured: true,
      async verify() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          active: true,
          provider: 'revenuecat',
          expiresAt: '2026-10-29T12:00:00.000Z',
          verifiedAt: '2026-09-29T12:00:00.000Z',
          productIdentifier: 'monthly',
        };
      },
    };
    const service = new EntitlementService(store, provider, () => new Date('2026-09-29T12:00:00.000Z'));
    const results = await Promise.all([
      service.resolve('user-1', { forceRefresh: true }),
      service.resolve('user-1', { forceRefresh: true }),
    ]);
    expect(results.every((result) => result.isPro)).toBe(true);
    expect(calls).toBe(1);
  });

  test('uses only a still-unexpired verified cache during a provider outage', async () => {
    const store = new MemoryEntitlementStore();
    store.value = { active: true, provider: 'revenuecat', expiresAt: '2026-09-30T00:00:00.000Z', verifiedAt: '2026-09-01T00:00:00.000Z', productIdentifier: 'monthly' };
    const service = new EntitlementService(
      store,
      verifier(true, new EntitlementVerificationError('provider_unavailable')),
      () => new Date('2026-09-29T12:00:00.000Z'),
      60_000,
    );
    expect(await service.resolve('user-1')).toMatchObject({ isPro: true, status: 'active' });

    const expired = new EntitlementService(
      store,
      verifier(true, new EntitlementVerificationError('provider_unavailable')),
      () => new Date('2026-10-01T12:00:00.000Z'),
      60_000,
    );
    expect(await expired.resolve('user-1')).toMatchObject({ isPro: false, status: 'inactive' });
  });
});

describe('Pro route gating', () => {
  test('reports an unavailable verifier as an outage, not a Free entitlement', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('uid', 'user-1'); await next(); });
    app.get('/pro', createRequirePro(async () => entitlement({
      status: 'unavailable',
      provider: 'none',
      verifiedAt: null,
    })), (c) => c.json({ ok: true }));
    const response = await app.request('/pro');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'entitlement_unavailable' });
  });

  test('returns a stable paywall response without invoking the handler', async () => {
    let invoked = false;
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('uid', 'user-1'); await next(); });
    app.get('/pro', createRequirePro(async () => entitlement()), (c) => {
      invoked = true;
      return c.json({ ok: true });
    });
    const response = await app.request('/pro');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'pro_required' });
    expect(invoked).toBe(false);
  });

  test('allows a server-verified Pro entitlement', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('uid', 'user-1'); await next(); });
    app.get('/pro', createRequirePro(async () => entitlement({ isPro: true, status: 'active' })), (c) => c.json({ ok: true }));
    const response = await app.request('/pro');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
