// Matching grocery item text against the category cache.
//
// Auto-categorization now runs every time an item lands on a list, so the cache
// in front of the model is what keeps that affordable. An exact-string cache
// only ever hit on wording the user had typed character for character before;
// "2 lbs Chicken Breasts" and "chicken breast" were two different novel items,
// and both paid for a model call.
//
// Everything here is pure and environment-neutral so it can be unit tested
// without Firebase or an API key.

/**
 * The original cache key: lowercase with whitespace removed.
 *
 * Kept byte-for-byte because every entry written since the cache existed is
 * stored under it — changing it would silently orphan the whole cache and send
 * a year of already-categorized items back to the model.
 */
export const normalizeItemText = (text: string): string =>
  String(text ?? '').toLowerCase().replace(/\s+/g, '');

/** Measurement words. "2 lbs chicken" and "chicken" are the same aisle. */
const UNIT_WORDS = new Set([
  'g', 'gram', 'grams', 'kg', 'kilo', 'kilos', 'kilogram', 'kilograms',
  'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  'ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters',
  'l', 'litre', 'litres', 'liter', 'liters',
  'tsp', 'teaspoon', 'teaspoons', 'tbsp', 'tablespoon', 'tablespoons',
  'cup', 'cups', 'pint', 'pints', 'quart', 'quarts', 'gallon', 'gallons',
  'can', 'cans', 'jar', 'jars', 'tin', 'tins', 'box', 'boxes',
  'bag', 'bags', 'bottle', 'bottles', 'packet', 'packets',
  'package', 'packages', 'pkg', 'pack', 'packs', 'container', 'containers',
  'bunch', 'bunches', 'head', 'heads', 'stalk', 'stalks', 'sprig', 'sprigs',
  'clove', 'cloves', 'slice', 'slices', 'piece', 'pieces',
  'dash', 'dashes', 'pinch', 'pinches', 'handful', 'handfuls', 'x',
]);

/**
 * Words that describe preparation, size or grade — none of which move an item
 * to a different aisle, so dropping them makes more wordings collide on one
 * cache entry.
 *
 * Deliberately NOT here: fresh, frozen, canned, dried, smoked, pickled, ground,
 * cooked, raw. Those DO decide the aisle (frozen peas are Frozen Foods, fresh
 * peas are Produce), so stripping them would answer confidently and wrongly.
 */
const STRIP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'with', 'for', 'plus', 'some',
  'chopped', 'chop', 'diced', 'dice', 'minced', 'mince', 'sliced',
  'grated', 'shredded', 'crushed', 'melted', 'softened', 'beaten', 'whisked',
  'peeled', 'cubed', 'julienned', 'halved', 'quartered', 'divided', 'packed',
  'sifted', 'drained', 'rinsed', 'trimmed', 'seeded', 'pitted', 'stemmed',
  'finely', 'roughly', 'coarsely', 'thinly', 'thickly', 'lightly', 'well',
  'optional', 'more', 'extra', 'room', 'temperature',
  'large', 'small', 'medium', 'jumbo', 'mini', 'baby', 'ripe', 'whole',
  'boneless', 'skinless', 'bone', 'in', 'skin', 'on', 'lean',
  'organic', 'free', 'range', 'natural', 'premium', 'quality',
  'unsalted', 'salted', 'low', 'reduced', 'nonfat', 'skim', 'lowfat', 'plain',
  'good', 'best', 'nice', 'your', 'favourite', 'favorite',
]);

/** Bare numbers, decimals, fractions and ranges: "2", "1.5", "1/2", "2-3". */
const QUANTITY_TOKEN = /^\d+(?:[.,]\d+)*(?:[/-]\d+(?:[.,]\d+)*)?$/;

/** Vulgar fractions arrive from pasted recipes and are pure quantity. */
const VULGAR_FRACTIONS = /[¼-¾⅐-⅞]/g;

/**
 * Naive English singularization. Wrong for irregulars ("leaves" stays
 * "leave"), which costs nothing here: both spellings canonicalize the same way,
 * so they still share one cache entry.
 */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  // tomatoes -> tomato, potatoes -> potato. Without this they land on
  // "tomatoe", which the singular never canonicalizes to, so the two spellings
  // would sit in the cache as two separate items.
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (/(?:ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/**
 * The meaningful words of an item, with quantity, units, packaging and prep
 * stripped and plurals folded away. "2 lbs of Boneless Chicken Breasts" and
 * "chicken breast" both come out as ["chicken", "breast"].
 */
export function canonicalTokens(text: string): string[] {
  const cleaned = String(text ?? '')
    .toLowerCase()
    // Parentheticals are asides ("(optional)", "(about 2 cups)"), never the item.
    .replace(/\([^)]*\)/g, ' ')
    .replace(VULGAR_FRACTIONS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (!cleaned) return [];
  const words = cleaned.split(' ').filter(Boolean);

  const kept = words
    .filter((w) => !QUANTITY_TOKEN.test(w))
    .filter((w) => !UNIT_WORDS.has(w))
    .filter((w) => !STRIP_WORDS.has(w))
    .map(singularize)
    .filter(Boolean);

  // "extra large" is all modifier and nothing else. Rather than canonicalize it
  // to nothing (which would collide with every other all-modifier string), fall
  // back to the words as written.
  return kept.length > 0 ? kept : words.map(singularize);
}

/**
 * Cache key for the canonical form. Hyphen-joined so it stays a legal RTDB key
 * and reads back as words, and so it never collides with a legacy
 * `normalizeItemText` key for a multi-word item.
 */
export function canonicalKey(text: string): string {
  const tokens = canonicalTokens(text);
  return tokens.length > 0 ? tokens.join('-') : normalizeItemText(text);
}

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
