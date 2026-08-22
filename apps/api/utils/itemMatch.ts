// Matching grocery item text against the category cache.
//
// Auto-categorization now runs every time an item lands on a list, so the cache
// in front of the model is what keeps that affordable. An exact-string cache
// only ever hit on wording the user had typed character for character before;
// "2 lbs Chicken Breasts" and "chicken breast" were two different novel items,
// and both paid for a model call.
//
// The text canonicalization this is built on now lives in
// packages/shared/itemText.ts, because the staples feature needs the client to
// derive the identical key. Re-exported here so every existing
// `@/utils/itemMatch` import keeps working.
//
// Everything here is pure and environment-neutral so it can be unit tested
// without Firebase or an API key.

import { canonicalKey, canonicalTokens, normalizeItemText } from '@fridgie/shared/itemText';

export { canonicalKey, canonicalTokens, normalizeItemText };

/** Same words in any order — "breast chicken" is "chicken breast". */
function tokenSetKey(key: string): string {
  return key.split('-').filter(Boolean).sort().join('-');
}

/**
 * Levenshtein distance, abandoned as soon as it is provably over `max`.
 * Returns `max + 1` when it gives up, which every caller reads as "too far".
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }

  return prev[b.length]!;
}

/**
 * How far apart two keys may be and still be called the same item.
 *
 * Short words are the trap: "beef"/"beer" and "corn"/"cork" are one edit apart
 * and aisles away from each other, so nothing under six characters gets any
 * typo tolerance at all.
 */
function editBudget(a: string, b: string): number {
  const shortest = Math.min(a.length, b.length);
  if (shortest >= 11) return 2;
  if (shortest >= 6) return 1;
  return 0;
}

/** A lookup built once per request over whatever the cache node holds. */
export interface CategoryIndex {
  /** Every key in the cache, exactly as stored, to its section. */
  byKey: Map<string, string>;
  /** Canonical keys with their words sorted, for order-insensitive matching. */
  byTokenSet: Map<string, string>;
}

export function buildCategoryIndex(cache: Record<string, string>): CategoryIndex {
  const byKey = new Map<string, string>();
  const byTokenSet = new Map<string, string>();

  for (const [key, section] of Object.entries(cache ?? {})) {
    if (typeof section !== 'string' || !section) continue;
    byKey.set(key, section);
    const setKey = tokenSetKey(key);
    if (!byTokenSet.has(setKey)) byTokenSet.set(setKey, section);
  }

  return { byKey, byTokenSet };
}

export type MatchSource = 'exact' | 'canonical' | 'reordered' | 'fuzzy';

export interface CategoryMatch {
  section: string;
  source: MatchSource;
}

/**
 * The section already known for `text`, or null when the model has to decide.
 *
 * Tried in descending confidence: the literal string the user typed, its
 * canonical form, the same words in another order, and finally a near-miss
 * spelling. Deliberately conservative — a wrong aisle is worse than a model
 * call, so nothing matches on partial overlap ("milk" never answers for
 * "coconut milk").
 */
export function findCategory(text: string, index: CategoryIndex): CategoryMatch | null {
  const exact = index.byKey.get(normalizeItemText(text));
  if (exact) return { section: exact, source: 'exact' };

  const canonical = canonicalKey(text);
  const direct = index.byKey.get(canonical);
  if (direct) return { section: direct, source: 'canonical' };

  const reordered = index.byTokenSet.get(tokenSetKey(canonical));
  if (reordered) return { section: reordered, source: 'reordered' };

  let best: { section: string; distance: number } | null = null;
  for (const [key, section] of index.byKey) {
    const budget = editBudget(canonical, key);
    if (budget === 0) continue;
    const distance = boundedEditDistance(canonical, key, budget);
    if (distance <= budget && (!best || distance < best.distance)) {
      best = { section, distance };
      if (distance === 1) break;
    }
  }

  return best ? { section: best.section, source: 'fuzzy' } : null;
}

/**
 * The keys a resolved item should be written back under: the literal wording so
 * the next identical string is free, and the canonical form so every other
 * phrasing of it is too.
 *
 * Filters to what RTDB will actually accept as a key. A rejected key fails the
 * whole write, which would turn one unusually punctuated grocery row into a
 * failed categorization for every item alongside it.
 */
export function cacheKeysFor(text: string): string[] {
  const keys = new Set([normalizeItemText(text), canonicalKey(text)]);
  return [...keys].filter(
    (k) =>
      k.length > 0 &&
      // RTDB caps keys at 768 bytes; nothing this long is a grocery item.
      k.length <= 200 &&
      !/[.#$[\]/]/.test(k) &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(k),
  );
}
