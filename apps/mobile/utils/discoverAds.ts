import type {
  DiscoverAdCadence,
  DiscoverAdProviderName,
  DiscoverAdvertisingConfig,
  DiscoverHouseAd,
} from '@/types/types';

export const DEFAULT_DISCOVER_AD_CADENCE: DiscoverAdCadence = Object.freeze({
  firstAfter: 6,
  interval: 10,
  maxPerSession: 2,
});

export const DISABLED_DISCOVER_ADS: DiscoverAdvertisingConfig = Object.freeze<DiscoverAdvertisingConfig>({
  enabled: false,
  providerOrder: ['house'],
  cadence: DEFAULT_DISCOVER_AD_CADENCE,
  houseAds: [],
  targetingMode: 'contextual',
});

export type AdEntitlementState = 'ad-supported' | 'ad-free' | 'unknown';

export interface DiscoverAdPlanningState {
  organicCount: number;
  nextSlotAt: number;
  slotsPlanned: number;
}

export type PlannedDiscoverRow<T> =
  | { kind: 'organic'; item: T }
  | { kind: 'ad-slot'; slot: number; afterOrganic: number };

const integerInRange = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const safeString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : undefined;
};

const SAFE_APP_ROUTES = new Set(['connect-claude', 'explore', 'groups', 'meal-preferences', 'profile']);
const SAFE_WEB_HOSTS = new Set(['fridgie.ca', 'www.fridgie.ca']);

function isSafeAppRoute(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /%(?:2f|5c)/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const firstSegment = value.slice(1).split(/[/?#]/, 1)[0];
  return !!firstSegment && SAFE_APP_ROUTES.has(firstSegment);
}

export function isSafeHouseDestination(value: string): boolean {
  if (value.startsWith('/')) return isSafeAppRoute(value);
  if (/%(?:2f|5c)/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return false;
    if (url.protocol === 'fridgie:') {
      const route = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
      return isSafeAppRoute(route);
    }
    return url.protocol === 'https:' && SAFE_WEB_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function safeHouseAsset(value: unknown): string | undefined {
  const asset = safeString(value, 500);
  if (!asset) return undefined;
  try {
    const url = new URL(asset);
    const dedicatedFirebaseAsset = url.hostname === 'firebasestorage.googleapis.com'
      && url.pathname.startsWith('/v0/b/grocerease-5abbb.firebasestorage.app/o/discover-ads%2F');
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (SAFE_WEB_HOSTS.has(url.hostname) || dedicatedFirebaseAsset)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeHouseAd(value: unknown): DiscoverHouseAd | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const id = safeString(input.id, 64);
  const headline = safeString(input.headline, 100);
  const body = safeString(input.body, 240);
  const ctaLabel = safeString(input.ctaLabel, 32);
  const destinationUrl = safeString(input.destinationUrl, 500);
  if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id) || !headline || !body || !ctaLabel || !destinationUrl || !isSafeHouseDestination(destinationUrl) || (Object.hasOwn(input, 'brand') && input.brand !== 'Fridgie')) return null;
  const imageUrl = safeHouseAsset(input.imageUrl);
  const logoUrl = safeHouseAsset(input.logoUrl);
  return {
    id,
    brand: 'Fridgie',
    headline,
    body,
    ctaLabel,
    destinationUrl,
    ...(imageUrl ? { imageUrl } : {}),
    ...(logoUrl ? { logoUrl } : {}),
  };
}

/** Re-validates the API response because remote config is an untrusted boundary. */
export function normalizeDiscoverAdvertising(value: unknown): DiscoverAdvertisingConfig {
  if (!value || typeof value !== 'object') return DISABLED_DISCOVER_ADS;
  const input = value as Record<string, unknown>;
  if (input.enabled !== true) return DISABLED_DISCOVER_ADS;

  const cadenceInput = input.cadence && typeof input.cadence === 'object'
    ? input.cadence as Record<string, unknown>
    : {};
  const cadence: DiscoverAdCadence = {
    firstAfter: integerInRange(cadenceInput.firstAfter, DEFAULT_DISCOVER_AD_CADENCE.firstAfter, 6, 100),
    interval: integerInRange(cadenceInput.interval, DEFAULT_DISCOVER_AD_CADENCE.interval, 8, 12),
    maxPerSession: integerInRange(cadenceInput.maxPerSession, DEFAULT_DISCOVER_AD_CADENCE.maxPerSession, 0, 5),
  };

  const providerOrder: DiscoverAdProviderName[] = [];
  if (Array.isArray(input.providerOrder)) {
    for (const provider of input.providerOrder) {
      if ((provider === 'house' || provider === 'admob') && !providerOrder.includes(provider)) providerOrder.push(provider);
    }
  }
  if (!providerOrder.length) providerOrder.push('house');

  const houseAds: DiscoverHouseAd[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input.houseAds)) {
    for (const value of input.houseAds) {
      if (houseAds.length >= 20) break;
      const ad = sanitizeHouseAd(value);
      if (ad && !seen.has(ad.id)) {
        seen.add(ad.id);
        houseAds.push(ad);
      }
    }
  }

  return { enabled: cadence.maxPerSession > 0, providerOrder, cadence, houseAds, targetingMode: 'contextual' };
}

export function initialDiscoverAdPlanningState(cadence: DiscoverAdCadence): DiscoverAdPlanningState {
  return { organicCount: 0, nextSlotAt: cadence.firstAfter, slotsPlanned: 0 };
}

/**
 * Adds stable provider-neutral slots without deleting, replacing, or reordering
 * an organic item. Carry the returned state into the next page/shelf.
 */
export function appendDiscoverAdSlots<T>(
  organics: readonly T[],
  state: DiscoverAdPlanningState,
  cadence: DiscoverAdCadence,
): { rows: PlannedDiscoverRow<T>[]; state: DiscoverAdPlanningState } {
  const next = { ...state };
  const rows: PlannedDiscoverRow<T>[] = [];
  for (const item of organics) {
    next.organicCount += 1;
    rows.push({ kind: 'organic', item });
    if (next.slotsPlanned < cadence.maxPerSession && next.organicCount >= next.nextSlotAt) {
      next.slotsPlanned += 1;
      rows.push({ kind: 'ad-slot', slot: next.slotsPlanned, afterOrganic: next.organicCount });
      next.nextSlotAt = next.organicCount + cadence.interval;
    }
  }
  return { rows, state: next };
}

export function canRequestDiscoverAds(config: DiscoverAdvertisingConfig, entitlement: AdEntitlementState): boolean {
  return config.enabled && config.cadence.maxPerSession > 0 && entitlement === 'ad-supported';
}

export type DiscoverAdKind = 'house' | 'paid';

export function sponsoredCardPresentation(kind: DiscoverAdKind, brand: string) {
  const safeBrand = brand.trim() || (kind === 'house' ? 'Fridgie' : 'Advertiser');
  return {
    disclosure: kind === 'house' ? 'From Fridgie' : `Advertisement · ${safeBrand}`,
    why: kind === 'house'
      ? 'This is an internal Fridgie promotion selected by Fridgie. It is not based on your personal data.'
      : 'This ad is supplied by Google AdMob in contextual, non-personalized mode and is not guaranteed to be about food or groceries. Fridgie does not send your searches, recipes, grocery list, allergies, diets, or household profile.',
    requiresAdChoices: kind === 'paid',
    actionLabels: {
      why: 'Why this ad?',
      hide: `Hide this ${kind === 'house' ? 'Fridgie promotion' : 'advertisement'}`,
      report: `Report this ${kind === 'house' ? 'Fridgie promotion' : 'advertisement'}`,
    },
  } as const;
}

/** Session-only controls: no identifiers or behavior are persisted. */
export class DiscoverAdSession {
  private readonly seen = new Set<string>();
  private readonly hidden = new Set<string>();
  private readonly reported = new Set<string>();
  private served = 0;

  canLoad(maxPerSession: number): boolean {
    return this.served < maxPerSession;
  }

  isExcluded(id: string): boolean {
    return this.seen.has(id) || this.hidden.has(id) || this.reported.has(id);
  }

  accept(id: string, maxPerSession: number): boolean {
    if (!id || !this.canLoad(maxPerSession) || this.isExcluded(id)) return false;
    this.seen.add(id);
    this.served += 1;
    return true;
  }

  hide(id: string): void {
    this.hidden.add(id);
  }

  report(id: string): void {
    this.reported.add(id);
    this.hidden.add(id);
  }

  get servedCount(): number {
    return this.served;
  }
}

export function dismissDiscoverAd(
  session: DiscoverAdSession,
  id: string,
  action: 'hide' | 'report',
  record: (event: 'hide' | 'report') => void,
): void {
  if (action === 'report') session.report(id);
  else session.hide(id);
  record(action);
}
