// Which meal(s) put a grocery row on the list — the backlink from an item on
// the shopping list to the meal plan that asked for it.
//
// The grocery list aggregates identical items into one row, so a single row can
// stand for several source items, and each of those can belong to a different
// meal ("2 onions" for the curry plus "1 onion" for the soup). Turning a row's
// source items into the distinct list of meal names it was required for is the
// whole of the backlink; the list shows the result in grey beside the item.
//
// Pure and component-free so it can be unit tested and so the derivation lives
// in one place rather than tangled into a render pass.

import { Item, Meal } from '@/types/types';

/**
 * Meal id → display name, with meals that have no usable name left out.
 *
 * A meal being typed out has an empty name for a moment, and a row pointing at
 * one should show nothing rather than an empty tag — so dropping the nameless
 * meals here means callers never have to guard against blank labels.
 */
export function mealNameIndex(meals: Meal[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const meal of meals) {
    const name = (meal.name ?? '').trim();
    if (name) index.set(meal.id, name);
  }
  return index;
}

/**
 * The distinct meal names a set of source items belongs to, in the order the
 * meals are first seen among those items.
 *
 * Deduped by meal id rather than by name: two meals really can share a name,
 * and collapsing them would undercount. A source item with no `mealId` (a row
 * the user typed straight onto the list) or one whose meal is absent from
 * `index` (unnamed, or since deleted) contributes nothing.
 */
export function mealNamesForItems(sources: Item[], index: Map<string, string>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of sources) {
    const mealId = item.mealId;
    if (!mealId || seen.has(mealId)) continue;
    seen.add(mealId);
    const name = index.get(mealId);
    if (name) names.push(name);
  }
  return names;
}
