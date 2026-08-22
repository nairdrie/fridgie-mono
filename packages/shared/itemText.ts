// Canonicalizing grocery item text — the single implementation used by BOTH
// apps, for the same reason quantity.ts and rank.ts are here.
//
// It was server-only while its only consumer was the category cache. Staples
// changed that: the server decides that "olive oil" is one, and the client has
// to recognise the row in front of it as the same thing. Two normalizers would
// disagree about "2 tbsp Olive Oil" and the strip would show a staple the user
// had already been told was hidden.
//
// The keys these produce are also RTDB keys, and every entry written since the
// category cache existed is stored under them — so the output of
// `normalizeItemText` and `canonicalKey` is frozen. Changing either orphans a
// year of cached categorizations.
//
// Environment-neutral: pure string logic, no Bun, no react-native, no firebase.

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
