import { fs } from './firebase';

export type EntitlementState = 'active' | 'inactive' | 'unavailable';
export type EntitlementProviderName = 'revenuecat' | 'none';

export interface PublicEntitlement {
  status: EntitlementState;
  provider: EntitlementProviderName;
  expiresAt: string | null;
  verifiedAt: string | null;
  productIdentifier: string | null;
}

export interface ResolvedEntitlement extends PublicEntitlement {
  isPro: boolean;
}

export interface VerifiedEntitlement {
  active: boolean;
  provider: 'revenuecat';
  expiresAt: string | null;
  verifiedAt: string;
  productIdentifier: string | null;
}

export interface EntitlementVerifier {
  readonly provider: 'revenuecat';
  readonly configured: boolean;
  verify(appUserId: string, now?: Date): Promise<VerifiedEntitlement>;
}

export interface EntitlementStore {
  read(uid: string): Promise<VerifiedEntitlement | null>;
  write(uid: string, entitlement: VerifiedEntitlement): Promise<void>;
}

export class EntitlementVerificationError extends Error {
  constructor(readonly code: 'not_configured' | 'provider_unavailable' | 'invalid_response') {
    super(code);
    this.name = 'EntitlementVerificationError';
  }
}

type RevenueCatPayload = {
  subscriber?: {
    entitlements?: Record<string, {
      expires_date?: string | null;
      grace_period_expires_date?: string | null;
      product_identifier?: string;
    }>;
  };
};

/** Convert RevenueCat's customer response into the only fields Fridgie trusts. */
export function parseRevenueCatEntitlement(
  payload: unknown,
  entitlementId: string,
  now: Date = new Date(),
): VerifiedEntitlement {
  if (!payload || typeof payload !== 'object') {
    throw new EntitlementVerificationError('invalid_response');
  }

  const subscriber = (payload as RevenueCatPayload).subscriber;
  if (!subscriber || typeof subscriber !== 'object') {
    throw new EntitlementVerificationError('invalid_response');
  }

  const entitlement = subscriber.entitlements?.[entitlementId];
  const verifiedAt = now.toISOString();
  if (!entitlement) {
    return { active: false, provider: 'revenuecat', expiresAt: null, verifiedAt, productIdentifier: null };
  }

  const rawExpiry = entitlement.expires_date;
  const rawGraceExpiry = entitlement.grace_period_expires_date;
  let expiresAt: string | null = null;
  let active = false;
  if (rawExpiry === null) {
    // RevenueCat represents lifetime entitlements with a null expiration.
    active = true;
  } else if (typeof rawExpiry === 'string') {
    const parsed = new Date(rawExpiry);
    if (!Number.isFinite(parsed.getTime())) throw new EntitlementVerificationError('invalid_response');
    expiresAt = parsed.toISOString();
    active = parsed.getTime() > now.getTime();
  } else {
    throw new EntitlementVerificationError('invalid_response');
  }

  // RevenueCat keeps an entitlement active while the store is attempting to
  // recover billing. Use the later verified boundary so a subscriber in grace
  // period is not abruptly downgraded. A malformed optional boundary makes the
  // provider response untrustworthy; it never grants access optimistically.
  if (rawExpiry !== null && rawGraceExpiry !== undefined && rawGraceExpiry !== null) {
    if (typeof rawGraceExpiry !== 'string') {
      throw new EntitlementVerificationError('invalid_response');
    }
    const graceExpiry = new Date(rawGraceExpiry);
    if (!Number.isFinite(graceExpiry.getTime())) {
      throw new EntitlementVerificationError('invalid_response');
    }
    if (!expiresAt || graceExpiry.getTime() > new Date(expiresAt).getTime()) {
      expiresAt = graceExpiry.toISOString();
    }
    active = active || graceExpiry.getTime() > now.getTime();
  }

  return {
    active,
    provider: 'revenuecat',
    expiresAt,
    verifiedAt,
    productIdentifier: typeof entitlement.product_identifier === 'string'
      ? entitlement.product_identifier.slice(0, 200)
      : null,
  };
}

export class RevenueCatEntitlementVerifier implements EntitlementVerifier {
  readonly provider = 'revenuecat' as const;
  readonly configured: boolean;

  constructor(
    private readonly apiKey = process.env.REVENUECAT_SECRET_API_KEY?.trim() ?? '',
    private readonly entitlementId = process.env.REVENUECAT_ENTITLEMENT_ID?.trim() || 'fridgie_pro',
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configured = this.apiKey.length > 0;
  }

  async verify(appUserId: string, now: Date = new Date()): Promise<VerifiedEntitlement> {
    if (!this.configured) throw new EntitlementVerificationError('not_configured');

    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          signal: AbortSignal.timeout(8_000),
        },
      );
    } catch {
      throw new EntitlementVerificationError('provider_unavailable');
    }

    if (!response.ok) throw new EntitlementVerificationError('provider_unavailable');
    try {
      return parseRevenueCatEntitlement(await response.json(), this.entitlementId, now);
    } catch (error) {
      if (error instanceof EntitlementVerificationError) throw error;
      throw new EntitlementVerificationError('invalid_response');
    }
  }
}

const validStoredEntitlement = (value: unknown): value is VerifiedEntitlement => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<VerifiedEntitlement>;
  return typeof record.active === 'boolean'
    && record.provider === 'revenuecat'
    && typeof record.verifiedAt === 'string'
    && Number.isFinite(new Date(record.verifiedAt).getTime())
    && (record.expiresAt === null
      || (typeof record.expiresAt === 'string' && Number.isFinite(new Date(record.expiresAt).getTime())))
    && (record.productIdentifier === null || typeof record.productIdentifier === 'string');
};

export class FirestoreEntitlementStore implements EntitlementStore {
  private ref(uid: string) {
    return fs.collection('users').doc(uid).collection('system').doc('entitlement');
  }

  async read(uid: string): Promise<VerifiedEntitlement | null> {
    const snapshot = await this.ref(uid).get();
    const value = snapshot.data();
    return validStoredEntitlement(value) ? value : null;
  }

  async write(uid: string, entitlement: VerifiedEntitlement): Promise<void> {
    await this.ref(uid).set(entitlement);
  }
}

const cacheTtlMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const seconds = Number(env.REVENUECAT_CACHE_TTL_SECONDS ?? 900);
  return Number.isFinite(seconds) && seconds >= 60 && seconds <= 86_400
    ? Math.trunc(seconds * 1000)
    : 15 * 60 * 1000;
};

const fromVerified = (verified: VerifiedEntitlement, now: Date): ResolvedEntitlement => {
  const notExpired = verified.expiresAt === null
    || new Date(verified.expiresAt).getTime() > now.getTime();
  const isPro = verified.active && notExpired;
  return {
    isPro,
    status: isPro ? 'active' : 'inactive',
    provider: 'revenuecat',
    expiresAt: verified.expiresAt,
    verifiedAt: verified.verifiedAt,
    productIdentifier: verified.productIdentifier,
  };
};

const unavailableEntitlement = (provider: EntitlementProviderName): ResolvedEntitlement => ({
  isPro: false,
  status: 'unavailable',
  provider,
  expiresAt: null,
  verifiedAt: null,
  productIdentifier: null,
});

export class EntitlementService {
  private readonly inFlight = new Map<string, Promise<VerifiedEntitlement>>();

  constructor(
    private readonly store: EntitlementStore,
    private readonly verifier: EntitlementVerifier,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = cacheTtlMs(),
  ) {}

  private async verifyOnce(uid: string, now: Date): Promise<VerifiedEntitlement> {
    const existing = this.inFlight.get(uid);
    if (existing) return existing;

    const pending = (async () => {
      const verified = await this.verifier.verify(uid, now);
      try {
        await this.store.write(uid, verified);
      } catch {
        // Verification is authoritative for this request even if caching it
        // fails. Do not turn a real purchase into a transient false negative.
      }
      return verified;
    })();
    this.inFlight.set(uid, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(uid) === pending) this.inFlight.delete(uid);
    }
  }

  async resolve(uid: string, options: { forceRefresh?: boolean } = {}): Promise<ResolvedEntitlement> {
    const now = this.now();
    let cached: VerifiedEntitlement | null = null;
    try {
      cached = await this.store.read(uid);
    } catch {
      // A provider lookup below can still securely establish entitlement.
    }

    const verifiedMs = cached ? new Date(cached.verifiedAt).getTime() : 0;
    const cacheFresh = cached !== null
      && now.getTime() - verifiedMs < this.ttlMs
      && fromVerified(cached, now).status === (cached.active ? 'active' : 'inactive');

    if (!options.forceRefresh && cacheFresh) return fromVerified(cached!, now);

    if (this.verifier.configured) {
      try {
        // Purchase listeners, a foreground refresh and the first quota request
        // can arrive together. Coalesce them per account instead of fanning out
        // identical RevenueCat reads from one server instance.
        const verified = await this.verifyOnce(uid, now);
        return fromVerified(verified, now);
      } catch {
        // A previously verified entitlement is a safe outage fallback only
        // through its known expiration. Refund/revocation will be caught on the
        // next successful refresh; no unverified purchase is ever promoted.
      }
    }

    return cached
      ? fromVerified(cached, now)
      : unavailableEntitlement(this.verifier.configured ? this.verifier.provider : 'none');
  }
}

const entitlementService = new EntitlementService(
  new FirestoreEntitlementStore(),
  new RevenueCatEntitlementVerifier(),
);

export const getEntitlement = (
  uid: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ResolvedEntitlement> => entitlementService.resolve(uid, options);

/** Authoritative server gate for Pro-only API routes. */
export const hasProEntitlement = async (uid: string): Promise<boolean> =>
  (await getEntitlement(uid)).isPro;
