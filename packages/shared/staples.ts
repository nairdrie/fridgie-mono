// Staples — the things this household always has, learned rather than entered.
//
// WHY THIS EXISTS
//
// Putting a recipe on the plan puts every one of its ingredients on the
// shopping list, including the cumin, the olive oil, the salt and the soy
// sauce. Plan four dinners and roughly a third of the list is things already in
// the cupboard, sitting between the user and the eight things they actually
// need. So every week they delete the same rows by hand, and every week the app
// forgets.
//
// That is not merely annoying. The premise of the whole product is "plan meals,
// get the shopping list for free"; a list that is a third wrong is a list you
// stop trusting, and a user who stops trusting it goes back to writing their
// own — at which point the meal plan is decoration.
//
// WHY IT IS NOT A PANTRY
//
// The obvious feature is an inventory: tell us what you have. Every app that
// has tried it has died on the data entry, because nobody is going to maintain
// a list of what is in their cupboard. So nothing here asks the user anything.
// The signal is already being generated: deleting a recipe's ingredient off the
// list, before ever ticking it off, is the user saying "I have this". Count
// those, and after STAPLE_THRESHOLD of them the row stops appearing in the list
// body.
//
// WHAT IS AND ISN'T A REJECTION
//
// This is the whole correctness question, because the failure mode is a feature
// that hides food people needed to buy. `detectStapleRejections` below is
// deliberately narrow, and every rule it applies exists because of a specific
// way the naive version gets it wrong — see the comments on each.
//
// Environment-neutral, per this package's README.

import { canonicalKey } from './itemText';

/**
 * Rejections before a row is treated as a staple.
 *
 * Three is chosen against real cadence rather than as a round number: a
 * planning session that adds four recipes rejects each true staple once or
 * twice, so salt and olive oil promote within about a fortnight — while a
 * one-off, the gochujang you happened to have in, needs the user to reject it
 * three separate times before it sticks.
 */
export const STAPLE_THRESHOLD = 3;

/** Minimal shapes, so this module doesn't depend on the full contract. */
interface StapleRow {
  id: string;
  text?: string;
  checked?: boolean;
  isSection?: boolean;
  mealId?: string;
}
interface StapleMeal {
  id: string;
}

/** RTDB rejects these in a key, and one bad key fails the whole write. */
const ILLEGAL_KEY_CHARS = /[.#$[\]/]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The key a row is counted and matched under. Empty when the text can't be used
 * as one, which every caller reads as "not a candidate".
 *
 * Shares `canonicalKey` with the category cache, so quantities, packaging and
 * plurals fall away: "2 tbsp Olive Oil", "olive oil" and "Olive Oils" are one
 * staple, and the client and the server always agree about which row is which.
 *
 * Matching is EXACT on that key, with no partial overlap — deliberately, and
 * for the same reason `findCategory` refuses it: "milk" must never answer for
 * "coconut milk". The cost is that a distinct wording like "extra virgin olive
 * oil" is its own key and has to earn staple status on its own. That is the
 * safe direction. The other one hides an ingredient the user needed.
 */
export function stapleKey(text?: string | null): string {
  const key = canonicalKey(String(text ?? '').trim());
  if (!key) return '';
  // Nothing this long is a grocery item, and RTDB caps keys at 768 bytes.
  if (key.length > 200) return '';
  if (ILLEGAL_KEY_CHARS.test(key) || CONTROL_CHARS.test(key)) return '';
  return key;
}

/** True when this row is one of the household's staples. */
export function isStapleRow(text: string | undefined, staples: ReadonlySet<string>): boolean {
  if (staples.size === 0) return false;
  const key = stapleKey(text);
  return !!key && staples.has(key);
}

/**
 * The staple keys rejected by one save — a list document before, and after.
 *
 * Returns each key at most once. Deleting salt from two different meals in the
 * same save is one decision, not two, and counting it twice would let a single
 * tidy-up promote a staple on its own.
 */
export function detectStapleRejections(
  prev: { items?: StapleRow[] | null; meals?: StapleMeal[] | null },
  next: { items?: StapleRow[] | null; meals?: StapleMeal[] | null },
): string[] {
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const nextItems = Array.isArray(next.items) ? next.items : [];
  if (prevItems.length === 0) return [];

  const survivingIds = new Set(nextItems.map((i) => i?.id).filter(Boolean));
  const survivingMealIds = new Set(
    (Array.isArray(next.meals) ? next.meals : []).map((m) => m?.id).filter(Boolean),
  );

  // Counted per meal so the two bulk-removal rules below can be applied: how
  // many of a meal's rows there were, and how many of them went.
  const removedPerMeal = new Map<string, number>();
  const totalPerMeal = new Map<string, number>();
  for (const row of prevItems) {
    if (!row?.mealId || row.isSection) continue;
    totalPerMeal.set(row.mealId, (totalPerMeal.get(row.mealId) ?? 0) + 1);
    if (!survivingIds.has(row.id)) {
      removedPerMeal.set(row.mealId, (removedPerMeal.get(row.mealId) ?? 0) + 1);
    }
  }

  const keys = new Set<string>();
  for (const row of prevItems) {
    if (!row || row.isSection) continue;

    // Only recipe-generated rows. A hand-typed row that gets deleted is someone
    // changing their mind about something they chose to write down — the app
    // never put it there, so there is nothing here for it to learn.
    if (!row.mealId) continue;

    if (survivingIds.has(row.id)) continue;

    // Never ticked off. Checking a row and THEN deleting it is tidying up after
    // a shop: the opposite signal, and the one that would end up hiding the
    // things the household reliably buys.
    if (row.checked) continue;

    // The row's meal also went. Deleting a meal deletes its ingredients with
    // it, so without this, changing your mind about Tuesday files every
    // ingredient of that recipe as something you always have — three abandoned
    // meals and the app starts hiding chicken thighs. This check is the
    // difference between a feature and a trap.
    if (!survivingMealIds.has(row.mealId)) continue;

    // The meal survived but lost ALL of its rows: a bulk clear ("I'll shop for
    // this one separately"), not an ingredient-by-ingredient judgement.
    if ((removedPerMeal.get(row.mealId) ?? 0) >= (totalPerMeal.get(row.mealId) ?? 0)) continue;

    const key = stapleKey(row.text);
    if (key) keys.add(key);
  }

  return [...keys];
}
