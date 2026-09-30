import type { Context, Next } from 'hono';
import { getEntitlement, type ResolvedEntitlement } from '@/utils/entitlements';

type EntitlementLookup = (uid: string) => Promise<ResolvedEntitlement>;

export const createRequirePro = (lookup: EntitlementLookup = getEntitlement) =>
  async (c: Context, next: Next) => {
    let entitlement: ResolvedEntitlement;
    try {
      entitlement = await lookup(c.get('uid'));
    } catch {
      return c.json({
        error: 'entitlement_unavailable',
        message: 'We could not verify Fridgie Pro right now. Please try again.',
      }, 503);
    }
    if (entitlement.status === 'unavailable') {
      return c.json({
        error: 'entitlement_unavailable',
        message: 'We could not verify Fridgie Pro right now. Please try again.',
      }, 503);
    }
    if (!entitlement.isPro) {
      return c.json({
        error: 'pro_required',
        message: 'This feature is included with Fridgie Pro.',
        entitlement: {
          status: entitlement.status,
          provider: entitlement.provider,
          expiresAt: entitlement.expiresAt,
          verifiedAt: entitlement.verifiedAt,
          productIdentifier: entitlement.productIdentifier,
        },
      }, 403);
    }
    return await next();
  };

export const requirePro = createRequirePro();
