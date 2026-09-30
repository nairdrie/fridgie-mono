import type {
  DiscoverAdCadence,
  DiscoverAdProviderName,
  DiscoverAdvertisingConfig,
  DiscoverHouseAd,
} from '@/utils/types';

/**
 * Safe server defaults. A Firestore document must opt in with `enabled: true`;
 * absence, a read failure, or every other value keeps the client switched off.
 */
export const DEFAULT_DISCOVER_AD_CADENCE: Readonly<DiscoverAdCadence> = Object.freeze({
  firstAfter: 6,
  interval: 10,
  maxPerSession: 2,
});

const MAX_FIRST_AD_POSITION = 100;
const MAX_ADS_PER_SESSION = 5;
const MAX_HOUSE_ADS = 20;
const FRIDGIE_WEB_HOSTS = new Set(['fridgie.ca', 'www.fridgie.ca']);
const FRIDGIE_STORAGE_BUCKET = 'grocerease-5abbb.firebasestorage.app';
const SAFE_APP_ROUTES = new Set([
  'connect-claude',
  'explore',
  'groups',
  'meal-preferences',
  'profile',
]);

const AD_PROVIDERS = new Set<DiscoverAdProviderName>(['house', 'admob']);
export const DISCOVER_AD_EVENTS = ['impression', 'click', 'hide', 'report'] as const;
export type DiscoverAdEventName = typeof DISCOVER_AD_EVENTS[number];
export interface DiscoverAdEvent {
  event: DiscoverAdEventName;
  provider: DiscoverAdProviderName;
}

function disabledConfig(): DiscoverAdvertisingConfig {
  return {
    enabled: false,
    providerOrder: [],
    cadence: { ...DEFAULT_DISCOVER_AD_CADENCE, maxPerSession: 0 },
    houseAds: [],
    targetingMode: 'contextual',
  };
}

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const safeString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
};

const safeHttpsAsset = (value: unknown): string | undefined => {
  const candidate = safeString(value, 500);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const isFridgieWebAsset = FRIDGIE_WEB_HOSTS.has(url.hostname);
    const isDedicatedFirebaseAsset = url.hostname === 'firebasestorage.googleapis.com'
      && url.pathname.startsWith(`/v0/b/${FRIDGIE_STORAGE_BUCKET}/o/discover-ads%2F`);
    if (!isFridgieWebAsset && !isDedicatedFirebaseAsset) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
};

const hasEncodedSeparator = (value: string): boolean => /%(?:2f|5c)/i.test(value);

const isSafeAppRoute = (value: string): boolean => {
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || hasEncodedSeparator(value)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  const firstSegment = value.slice(1).split(/[/?#]/, 1)[0];
  return !!firstSegment && SAFE_APP_ROUTES.has(firstSegment);
};

/** House cards are Fridgie content, so they cannot silently redirect elsewhere. */
export function isSafeHouseDestination(value: string): boolean {
  if (value.startsWith('/')) return isSafeAppRoute(value);
  if (hasEncodedSeparator(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;

  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return false;
    if (url.protocol === 'fridgie:') {
      const route = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
      return isSafeAppRoute(route);
    }
    return url.protocol === 'https:' && FRIDGIE_WEB_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function sanitizeHouseAd(value: unknown): DiscoverHouseAd | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const id = safeString(input.id, 64);
  const headline = safeString(input.headline, 100);
  const body = safeString(input.body, 240);
  const ctaLabel = safeString(input.ctaLabel, 32);
  const destinationUrl = safeString(input.destinationUrl, 500);
  if (
    !id
    || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)
    || !headline
    || !body
    || !ctaLabel
    || !destinationUrl
    || !isSafeHouseDestination(destinationUrl)
    || (Object.hasOwn(input, 'brand') && input.brand !== 'Fridgie')
  ) return null;

  const imageUrl = safeHttpsAsset(input.imageUrl);
  const logoUrl = safeHttpsAsset(input.logoUrl);
  return {
    id,
    // A missing brand is materialized honestly; a conflicting supplied brand
    // was rejected above rather than laundered into a Fridgie promotion.
    brand: 'Fridgie',
    headline,
    body,
    ctaLabel,
    destinationUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(logoUrl ? { logoUrl } : {}),
  };
}

/**
 * Turns the untrusted Firestore app-config document into the only advertising
 * shape the mobile app may receive. It is pure so the trust boundary can be
 * exhaustively tested without Firebase.
 */
export function materializeDiscoverAdvertising(value: unknown): DiscoverAdvertisingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return disabledConfig();
  const input = value as Record<string, unknown>;
  if (input.enabled !== true) return disabledConfig();

  const rawCadence = input.cadence && typeof input.cadence === 'object' && !Array.isArray(input.cadence)
    ? input.cadence as Record<string, unknown>
    : {};
  const cadence: DiscoverAdCadence = {
    firstAfter: boundedInteger(rawCadence.firstAfter, DEFAULT_DISCOVER_AD_CADENCE.firstAfter, 6, MAX_FIRST_AD_POSITION),
    interval: boundedInteger(rawCadence.interval, DEFAULT_DISCOVER_AD_CADENCE.interval, 8, 12),
    maxPerSession: boundedInteger(rawCadence.maxPerSession, DEFAULT_DISCOVER_AD_CADENCE.maxPerSession, 0, MAX_ADS_PER_SESSION),
  };

  const providerOrder: DiscoverAdProviderName[] = [];
  if (Array.isArray(input.providerOrder)) {
    for (const provider of input.providerOrder) {
      if (AD_PROVIDERS.has(provider as DiscoverAdProviderName) && !providerOrder.includes(provider as DiscoverAdProviderName)) {
        providerOrder.push(provider as DiscoverAdProviderName);
      }
    }
  }
  // A bad or absent provider list can never opt into a third party. It becomes
  // the credential-free house provider, whose empty inventory is a true no-fill.
  if (!providerOrder.length) providerOrder.push('house');

  const houseAds: DiscoverHouseAd[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(input.houseAds)) {
    for (const candidate of input.houseAds) {
      if (houseAds.length >= MAX_HOUSE_ADS) break;
      const ad = sanitizeHouseAd(candidate);
      if (ad && !seenIds.has(ad.id)) {
        seenIds.add(ad.id);
        houseAds.push(ad);
      }
    }
  }

  if (cadence.maxPerSession === 0) {
    const disabled = disabledConfig();
    disabled.cadence = { ...cadence, maxPerSession: 0 };
    return disabled;
  }

  return {
    enabled: true,
    providerOrder,
    cadence,
    houseAds,
    // Ignore any requested personalized mode. It is unsupported by design.
    targetingMode: 'contextual',
  };
}

/**
 * The event body deliberately has no slot for a UID, recipe, query, audience,
 * or creative identifier. Reject unknown fields instead of quietly accepting
 * a future caller that starts sending sensitive context.
 */
export function validateDiscoverAdEvent(value: unknown): DiscoverAdEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'event' || keys[1] !== 'provider') return null;
  if (!DISCOVER_AD_EVENTS.includes(input.event as DiscoverAdEventName)) return null;
  if (!AD_PROVIDERS.has(input.provider as DiscoverAdProviderName)) return null;
  return {
    event: input.event as DiscoverAdEventName,
    provider: input.provider as DiscoverAdProviderName,
  };
}

/** UTC makes one bounded aggregate document independent of server location. */
export function discoverAdEventDay(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('A valid event date is required.');
  return now.toISOString().slice(0, 10);
}
