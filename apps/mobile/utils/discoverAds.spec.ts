import { describe, expect, test } from 'bun:test';
import {
  appendDiscoverAdSlots,
  canRequestDiscoverAds,
  dismissDiscoverAd,
  DiscoverAdSession,
  DISABLED_DISCOVER_ADS,
  initialDiscoverAdPlanningState,
  normalizeDiscoverAdvertising,
  sponsoredCardPresentation,
} from './discoverAds';

const ids = (start: number, count: number) => Array.from({ length: count }, (_, index) => `recipe-${start + index}`);

describe('Discover sponsored placement', () => {
  test('carries cadence across pages and waits for six organic cards', () => {
    const cadence = { firstAfter: 6, interval: 10, maxPerSession: 3 };
    let state = initialDiscoverAdPlanningState(cadence);
    const first = appendDiscoverAdSlots(ids(1, 5), state, cadence);
    state = first.state;
    expect(first.rows.every(row => row.kind === 'organic')).toBe(true);

    const second = appendDiscoverAdSlots(ids(6, 7), state, cadence);
    state = second.state;
    expect(second.rows.filter(row => row.kind === 'ad-slot')).toEqual([{ kind: 'ad-slot', slot: 1, afterOrganic: 6 }]);

    const third = appendDiscoverAdSlots(ids(13, 14), state, cadence);
    expect(third.rows.filter(row => row.kind === 'ad-slot')).toEqual([
      { kind: 'ad-slot', slot: 2, afterOrganic: 16 },
      { kind: 'ad-slot', slot: 3, afterOrganic: 26 },
    ]);
  });

  test('never replaces or reorders organic content and caps the session', () => {
    const cadence = { firstAfter: 6, interval: 8, maxPerSession: 2 };
    const organic = ids(1, 40);
    const { rows } = appendDiscoverAdSlots(organic, initialDiscoverAdPlanningState(cadence), cadence);
    expect(rows.filter(row => row.kind === 'organic').map(row => row.kind === 'organic' && row.item)).toEqual(organic);
    expect(rows.filter(row => row.kind === 'ad-slot')).toHaveLength(2);
  });

  test('a no-fill projection has exactly the original organic feed and no gap row', () => {
    const cadence = { firstAfter: 6, interval: 10, maxPerSession: 2 };
    const organic = ids(1, 22);
    const { rows } = appendDiscoverAdSlots(organic, initialDiscoverAdPlanningState(cadence), cadence);
    const renderedWhenEveryProviderNoFills = rows.flatMap(row => row.kind === 'organic' ? [row.item] : []);
    expect(renderedWhenEveryProviderNoFills).toEqual(organic);
  });
});

describe('Discover ad trust boundaries', () => {
  const enabled = normalizeDiscoverAdvertising({
    enabled: true,
    providerOrder: ['admob', 'house', 'admob'],
    cadence: { firstAfter: 1, interval: 99, maxPerSession: 99 },
    houseAds: [{
      id: 'seasonal-soups', brand: 'Fridgie', headline: 'Soup season', body: 'Browse warming recipes.',
      ctaLabel: 'Browse recipes', destinationUrl: '/explore?collection=soups',
    }],
  });

  test('normalizes remote cadence, identity, providers, and contextual mode', () => {
    expect(enabled.cadence).toEqual({ firstAfter: 6, interval: 12, maxPerSession: 5 });
    expect(enabled.providerOrder).toEqual(['admob', 'house']);
    expect(enabled.houseAds[0].brand).toBe('Fridgie');
    expect(enabled.targetingMode).toBe('contextual');
  });

  test('kill switch, Pro, and unknown entitlement all suppress provider requests', () => {
    expect(canRequestDiscoverAds(DISABLED_DISCOVER_ADS, 'ad-supported')).toBe(false);
    expect(canRequestDiscoverAds(enabled, 'ad-free')).toBe(false);
    expect(canRequestDiscoverAds(enabled, 'unknown')).toBe(false);
    expect(canRequestDiscoverAds(enabled, 'ad-supported')).toBe(true);
  });

  test('rejects unsafe house destinations and malformed inventory', () => {
    const config = normalizeDiscoverAdvertising({
      enabled: true,
      houseAds: [
        { id: 'bad', headline: 'Bad', body: 'Bad', ctaLabel: 'Open', destinationUrl: 'https://tracker.example/ad' },
        { id: 'encoded', headline: 'Bad', body: 'Bad', ctaLabel: 'Open', destinationUrl: '/explore%2F..%2Fprofile' },
        { id: 'control', headline: 'Bad\nline', body: 'Bad', ctaLabel: 'Open', destinationUrl: '/explore' },
        { id: 'fake-brand', brand: 'A made-up sponsor', headline: 'Bad', body: 'Bad', ctaLabel: 'Open', destinationUrl: '/explore' },
        { id: 'good', headline: 'Good', body: 'Good', ctaLabel: 'Open', destinationUrl: 'https://fridgie.ca/collections/fall' },
      ],
    });
    expect(config.houseAds.map(ad => ad.id)).toEqual(['good']);
  });

  test('session deduplicates and preserves Hide/Report exclusions', () => {
    const session = new DiscoverAdSession();
    const events: string[] = [];
    expect(session.accept('house:a', 3)).toBe(true);
    expect(session.accept('house:a', 3)).toBe(false);
    dismissDiscoverAd(session, 'house:b', 'hide', event => events.push(event));
    dismissDiscoverAd(session, 'house:c', 'report', event => events.push(event));
    expect(session.accept('house:b', 3)).toBe(false);
    expect(session.accept('house:c', 3)).toBe(false);
    expect(session.accept('house:d', 3)).toBe(true);
    expect(session.servedCount).toBe(2);
    expect(events).toEqual(['hide', 'report']);
  });

  test('disclosures are unambiguous and precede a single provider-specific explanation', () => {
    const house = sponsoredCardPresentation('house', 'Fridgie');
    const paid = sponsoredCardPresentation('paid', 'Pantry Co');
    expect(house.disclosure).toBe('From Fridgie');
    expect(house.requiresAdChoices).toBe(false);
    expect(paid.disclosure).toBe('Advertisement · Pantry Co');
    expect(paid.requiresAdChoices).toBe(true);
    expect(paid.why).toContain('contextual, non-personalized');
    expect(paid.why).toContain('allergies');
    expect(paid.actionLabels).toEqual({
      why: 'Why this ad?',
      hide: 'Hide this advertisement',
      report: 'Report this advertisement',
    });
  });
});
