// The supermarket aisles, and the handful of items we file into them by hand.
//
// Categorization is a model call with an RTDB cache in front of it, and that
// pairing has one failure mode with no way back out on its own: an item the
// model reads wrongly is written to the cache wrongly, and from then on every
// rewording of it is answered wrongly for free, without a call. Hummus filed
// under Snacks & Candy and tortillas under Pantry are both exactly that shape —
// fair readings of the food, and not the aisle the shop keeps it in.
//
// The table below is the way out. It is consulted BEFORE the cache, so it
// corrects an answer already written as readily as one not yet given.
//
// Deliberately short: this is not a grocery taxonomy, it is the few items where
// what a thing IS and where it is SHELVED come apart. Everything absent from it
// is still the model's call.
//
// Pure — nothing here touches Firebase or an API key — so it unit tests
// directly.

import { canonicalTokens } from '@fridgie/shared/itemText';

/** Supermarket aisles, in the order they tend to appear. */
export const SECTIONS = [
  'Produce', 'Meat & Poultry', 'Seafood', 'Deli', 'Bakery', 'Dairy & Eggs',
  'Frozen Foods', 'Pantry', 'Canned Goods', 'Baking', 'Beverages',
  'Snacks & Candy', 'Health & Beauty', 'Household Essentials', 'Pet Supplies',
  'International', 'Floral', 'Alcohol',
] as const;

export type Section = (typeof SECTIONS)[number];

/** Where anything the model dropped or renamed ends up. Not a real aisle. */
export const FALLBACK_SECTION = 'Other';

/**
 * Items whose aisle we decide ourselves, keyed by the item's HEAD NOUN — the
 * words a shopper would end the item with.
 *
 * Written as ordinary text and canonicalized below, so an entry matches every
 * wording of it the same way the cache does: "flour tortillas", "8 corn
 * tortillas" and "tortilla" are all one entry.
 */
export const SECTION_OVERRIDES: Record<string, Section> = {
  // Flatbreads read as packaged pantry goods — they keep, and they arrive in a
  // sealed bag — but the shop shelves them with the bread.
  'tortilla': 'Bakery',
  'tortilla wrap': 'Bakery',
  'pita': 'Bakery',
  'pita bread': 'Bakery',
  'naan': 'Bakery',
  'naan bread': 'Bakery',
  'flatbread': 'Bakery',
  'flat bread': 'Bakery',
  // Fresh dips and spreads. What they get eaten WITH is the snack aisle, which
  // is the association that lands hummus next to the crisps; they are sold
  // refrigerated by the deli counter.
  'hummus': 'Deli',
  'tzatziki': 'Deli',
  'baba ganoush': 'Deli',
  'baba ghanoush': 'Deli',
};

/**
 * The table above, canonicalized once. Longest phrase first, so a more specific
 * entry always gets to answer before a shorter one it contains.
 */
const OVERRIDES = Object.entries(SECTION_OVERRIDES)
  .map(([phrase, section]) => ({ phrase: canonicalTokens(phrase), section }))
  .filter((entry) => entry.phrase.length > 0)
  .sort((a, b) => b.phrase.length - a.phrase.length);

/**
 * The aisle `text` is filed into by hand, or null to let the usual cache-then-
 * model route decide.
 *
 * Matches on the END of the canonical form rather than anywhere in it, because
 * that is where English puts the noun: the qualifiers of "roasted red pepper
 * hummus" and "8 whole wheat tortillas" come first, and the thing itself comes
 * last. Matching anywhere would file tortilla chips and pita chips — a
 * different food, correctly in Snacks & Candy — into the bread aisle.
 */
export function overrideSection(text: string): Section | null {
  const tokens = canonicalTokens(text);
  if (tokens.length === 0) return null;

  for (const { phrase, section } of OVERRIDES) {
    if (phrase.length > tokens.length) continue;
    const at = tokens.length - phrase.length;
    if (phrase.every((word, i) => tokens[at + i] === word)) return section;
  }

  return null;
}
