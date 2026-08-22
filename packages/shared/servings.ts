// Recipe yield, and what it means for a household that isn't the size the
// recipe was written for.
//
// WHY THIS EXISTS
//
// Every quantity in this app was, until now, implicitly "however many people
// the author cooked for". The importer read `recipeYield` off the page's
// JSON-LD and handed it to the model as context, then dropped it — it never
// reached a stored field, so nothing downstream could know it. The generation
// prompt says "Serves 4". So a couple bought double everything, forever, and a
// household of six bought two thirds and ran out.
//
// That is not a small error hiding in a corner: it is applied to every
// ingredient of every meal on the plan, and the grocery list is the app's
// entire output. The quantity engine next door converts cups to grams through
// a density table to get these numbers right, and then they were multiplied by
// the wrong integer.
//
// WHAT IS AND ISN'T SCALED
//
// The stored recipe is NEVER scaled. A recipe is a document with an author and
// a yield, it gets forked and shared, and rewriting its numbers to suit
// whoever added it to a list would corrupt it for everyone downstream.
// Scaling happens at exactly one moment — when a recipe's ingredients become
// rows on a grocery list — and the factor is recorded on the meal so the
// cooking view can show the same numbers the shopping list was built from.
//
// Environment-neutral, per this package's README: pure string/number logic.

import { formatValue, parseQuantity } from './quantity';

/**
 * Words that confirm a number counts PEOPLE. Anything else after the number
 * means the yield counts objects — "Makes 12 cookies", "1 loaf", "24 muffins"
 * — and scaling a household against a cookie count would divide every
 * quantity by twelve. Those yields are rejected rather than guessed at.
 */
const SERVING_WORDS = /^(servings?|serves?|serving|people|persons?|portions?|adults?|diners?)$/i;

/** Verbs a yield string opens with, stripped before the number is read. */
const YIELD_PREFIX = /^(?:makes|serves|yields?|feeds|for|about|approx\.?|approximately|around)\s+/i;

/** Below 1 or above this and the parse is wrong, not the recipe. */
const MAX_SERVINGS = 50;

/**
 * People a recipe feeds, or null when the string doesn't say.
 *
 * A range takes its LOW end: "serves 4-6" is a recipe that feeds four
 * properly and six if they're polite, and the low end is the number the
 * quantities were actually written against.
 */
export function parseServings(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 1 && raw <= MAX_SERVINGS ? Math.round(raw) : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim().replace(YIELD_PREFIX, '');
  if (!text) return null;

  // Leading number, optionally a range. Deliberately not VALUE_PATTERN from the
  // quantity engine: "½ serving" is not a thing, and accepting fractions here
  // would let "1/2 sheet pan" through.
  const match = text.match(/^(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?\s*(.*)$/);
  if (!match) return null;

  const low = parseInt(match[1]!, 10);
  if (!Number.isFinite(low) || low < 1 || low > MAX_SERVINGS) return null;

  // What follows the number decides whether it counted people or objects.
  const tail = (match[3] ?? '').trim();
  if (tail) {
    const head = tail.split(/[^a-zA-Z]+/).filter(Boolean)[0];
    if (!head || !SERVING_WORDS.test(head)) return null;
  }

  return low;
}

/**
 * Normalizes a model-produced `servings` in place.
 *
 * A valid count is kept as a clean integer; anything else — `null`, a string,
 * a number outside the plausible range — has the key REMOVED rather than
 * defaulted. That distinction is the whole safety property of this feature: an
 * absent yield means "don't scale", and writing a guessed 4 would make an
 * unknown yield indistinguishable from a stated one, silently halving the
 * shopping for a household of two.
 *
 * Deleting rather than setting `undefined` also keeps RTDB happy, which
 * rejects undefined values outright.
 */
export function normalizeRecipeServings<T extends Record<string, any>>(
  recipe: T,
): Omit<T, 'servings'> & { servings?: number } {
  const servings = parseServings(recipe.servings);
  if (servings) (recipe as { servings?: number }).servings = servings;
  else delete (recipe as { servings?: unknown }).servings;
  // The return type is narrower than `T` on purpose: after this runs the key
  // may genuinely be gone, and saying otherwise would let a caller read
  // `recipe.servings` as a guaranteed number.
  return recipe;
}

/**
 * How much of the recipe to buy for this household.
 *
 * Returns exactly 1 whenever either number is missing, which is what makes
 * this safe to switch on everywhere: a recipe with no yield, or a group that
 * has never set a size, behaves precisely as it does today.
 *
 * Clamped to [0.25, 8]. A factor outside that came from a misparsed yield
 * ("serves 1" on a tray bake) far more often than from a real household, and
 * the failure it prevents — a list quietly asking for 3 kg of pasta — is worse
 * than the one it causes.
 */
export function servingsScale(
  recipeServings?: number | null,
  householdSize?: number | null,
): number {
  if (!recipeServings || !householdSize) return 1;
  if (recipeServings <= 0 || householdSize <= 0) return 1;

  const factor = householdSize / recipeServings;
  if (!Number.isFinite(factor)) return 1;
  return Math.min(8, Math.max(0.25, factor));
}

/** Packaged units — you cannot buy 1.5 tins, so these round up to a whole. */
const PACKAGED_UNITS = new Set([
  'can', 'tin', 'jar', 'packet', 'package', 'pack', 'bag', 'box', 'bunch',
  'head', 'loaf', 'sheet',
]);

/**
 * Scales one canonical quantity string, preserving ranges and passing
 * unparseable strings ("to taste", "a splash", "1 cup or 200g") through
 * untouched — those carry no number to multiply and guessing at one is how you
 * end up with "2 to taste".
 *
 * Counts snap, because the point of the number is that a person can act on it:
 * half a lemon is an instruction, 0.67 of a lemon is not. Packaged units go
 * further and round up to a whole — under-buying a tin means the meal doesn't
 * happen, and the leftover half is a tin you already own.
 *
 * Mass and volume are left as computed. The display layer already rounds by
 * magnitude (`formatFriendlyValue`), and rounding twice loses more than it
 * tidies when several scaled rows are then aggregated together.
 */
export function scaleQuantity(quantity: unknown, factor: number): string {
  if (typeof quantity !== 'string') return '';
  const trimmed = quantity.trim();
  if (!trimmed || factor === 1) return trimmed;

  const parsed = parseQuantity(trimmed);
  if (!parsed) return trimmed;

  const snap = (n: number): number => {
    if (parsed.dimension !== 'count') return n;
    if (parsed.unit && PACKAGED_UNITS.has(parsed.unit)) {
      return Math.max(1, Math.ceil(n - 1e-9));
    }
    // Nearest half, never rounded away to nothing.
    return Math.max(0.5, Math.round(n * 2) / 2);
  };

  const lo = snap(parsed.min * factor);
  const hi = snap(parsed.max * factor);

  const amount = hi > lo ? `${formatValue(lo)}-${formatValue(hi)}` : formatValue(lo);
  return parsed.unit ? `${amount} ${parsed.unit}` : amount;
}

/**
 * Scales a recipe's ingredient list. Returns the input array unchanged at a
 * factor of 1 so callers can apply this unconditionally.
 */
export function scaleIngredients<T extends { quantity?: unknown }>(
  ingredients: T[] | undefined | null,
  factor: number,
): T[] {
  if (!Array.isArray(ingredients)) return [];
  if (factor === 1) return ingredients;
  return ingredients.map((ing) => ({ ...ing, quantity: scaleQuantity(ing?.quantity, factor) }));
}

/** "Scaled for 2" / "Serves 4" — one place so every surface words it the same. */
export function describeScale(
  recipeServings?: number | null,
  householdSize?: number | null,
): string | null {
  const factor = servingsScale(recipeServings, householdSize);
  if (factor === 1) return recipeServings ? `Serves ${recipeServings}` : null;
  return `Scaled for ${householdSize}`;
}
