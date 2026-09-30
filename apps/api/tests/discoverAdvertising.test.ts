import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DISCOVER_AD_CADENCE,
  discoverAdEventDay,
  isSafeHouseDestination,
  materializeDiscoverAdvertising,
  validateDiscoverAdEvent,
} from '../utils/discoverAdvertising';

const houseAd = (overrides: Record<string, unknown> = {}) => ({
  id: 'seasonal-soups',
  brand: 'Fridgie',
  headline: 'Warm up with soup season',
  body: 'Explore a useful Fridgie recipe collection.',
  ctaLabel: 'Explore recipes',
  destinationUrl: '/explore/seasonal-soups',
  imageUrl: 'https://firebasestorage.googleapis.com/v0/b/grocerease-5abbb.firebasestorage.app/o/discover-ads%2Fsoup.jpg?alt=media',
  ...overrides,
});

describe('Discover advertising config trust boundary', () => {
  test('fails closed when config is absent, malformed, or not explicitly enabled', () => {
    for (const value of [undefined, null, [], 'enabled', {}, { enabled: false }, { enabled: 'true' }]) {
      expect(materializeDiscoverAdvertising(value)).toEqual({
        enabled: false,
        providerOrder: [],
        cadence: { ...DEFAULT_DISCOVER_AD_CADENCE, maxPerSession: 0 },
        houseAds: [],
        targetingMode: 'contextual',
      });
    }
  });

  test('bounds cadence, deduplicates providers, and never enables personalization', () => {
    expect(materializeDiscoverAdvertising({
      enabled: true,
      providerOrder: ['admob', 'unknown', 'admob', 'house'],
      cadence: { firstAfter: -10, interval: 99, maxPerSession: 900 },
      targetingMode: 'personalized',
    })).toEqual({
      enabled: true,
      providerOrder: ['admob', 'house'],
      cadence: { firstAfter: 6, interval: 12, maxPerSession: 5 },
      houseAds: [],
      targetingMode: 'contextual',
    });

    expect(materializeDiscoverAdvertising({
      enabled: true,
      cadence: { firstAfter: 7.5, interval: '8', maxPerSession: -1 },
    })).toEqual({
      enabled: false,
      providerOrder: [],
      cadence: { firstAfter: 6, interval: 10, maxPerSession: 0 },
      houseAds: [],
      targetingMode: 'contextual',
    });
  });

  test('forces Fridgie identity, keeps safe assets, and drops unsafe or duplicate cards', () => {
    const result = materializeDiscoverAdvertising({
      enabled: true,
      providerOrder: ['house'],
      houseAds: [
        houseAd(),
        houseAd({ headline: 'Duplicate must not replace the first' }),
        houseAd({ id: 'print-preview', destinationUrl: 'https://www.fridgie.ca/print', logoUrl: 'https://fridgie.ca/assets/fridgie.png' }),
        houseAd({ id: 'false-sponsor', brand: 'Untrusted Sponsor' }),
        houseAd({ id: 'bad-host', destinationUrl: 'https://fridgie.ca.evil.test/phish' }),
        houseAd({ id: 'bad-scheme', destinationUrl: 'javascript:alert(1)' }),
        houseAd({ id: 'bad-id!' }),
        houseAd({ id: 'bad-asset', imageUrl: 'https://tracker.example.test/pixel.gif' }),
      ],
    });

    expect(result.houseAds.map(ad => ad.id)).toEqual(['seasonal-soups', 'print-preview', 'bad-asset']);
    expect(result.houseAds[0]).toMatchObject({ brand: 'Fridgie', destinationUrl: '/explore/seasonal-soups' });
    expect(result.houseAds[1]).toMatchObject({ brand: 'Fridgie', destinationUrl: 'https://www.fridgie.ca/print', logoUrl: 'https://fridgie.ca/assets/fridgie.png' });
    expect(result.houseAds[2]).not.toHaveProperty('imageUrl');
  });

  test('allows only internal house destinations', () => {
    for (const destination of ['/explore?collection=autumn', 'fridgie://explore?collection=autumn', 'fridgie:///profile/person', 'https://fridgie.ca/features', 'https://www.fridgie.ca/features']) {
      expect(isSafeHouseDestination(destination)).toBe(true);
    }
    for (const destination of ['//evil.test/path', '/\\evil', '/explore%2F..%2Flogin', '/oauthredirect', 'fridgie://evil', 'https://api.fridgie.ca/path', 'https://fridgie.ca:444/path', 'http://fridgie.ca/path', 'https://evilfridgie.ca/path', 'https://fridgie.ca@evil.test/path', 'javascript:alert(1)']) {
      expect(isSafeHouseDestination(destination)).toBe(false);
    }
  });
});

describe('Discover advertising event boundary', () => {
  test('accepts only allowlisted aggregate dimensions', () => {
    for (const event of ['impression', 'click', 'hide', 'report'] as const) {
      for (const provider of ['house', 'admob'] as const) {
        expect(validateDiscoverAdEvent({ event, provider })).toEqual({ event, provider });
      }
    }
  });

  test('rejects unknown values and any user or content context', () => {
    for (const value of [
      null,
      [],
      { event: 'view', provider: 'house' },
      { event: 'click', provider: 'adadapted' },
      { event: 'Click', provider: 'house' },
      { event: 'click' },
      { provider: 'house' },
      { event: 'click', provider: 'house', uid: 'private-user' },
      { event: 'click', provider: 'house', recipeId: 'private-recipe' },
      { event: 'click', provider: 'house', search: 'pregnancy diet' },
    ]) expect(validateDiscoverAdEvent(value)).toBeNull();
  });

  test('uses stable UTC aggregate document days', () => {
    expect(discoverAdEventDay(new Date('2026-09-29T23:59:59.999Z'))).toBe('2026-09-29');
    expect(discoverAdEventDay(new Date('2026-09-30T00:00:00.000Z'))).toBe('2026-09-30');
    expect(() => discoverAdEventDay(new Date('invalid'))).toThrow('valid event date');
  });
});
