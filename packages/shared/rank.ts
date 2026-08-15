// Shared LexoRank helpers — the single implementation used by BOTH apps.
//
// Client and server previously had separate copies that repaired invalid ranks
// differently (server interpolated in place, client appended to the bottom), so
// the two sides produced different orderings for the same stored list and fought
// each other across saves. Everything here must stay environment-neutral.

import { LexoRank } from 'lexorank';

export type RankField = 'listOrder' | 'mealOrder';

/** The open Item contract — unknown keys are carried through untouched. */
export interface RankableItem {
  id?: string;
  listOrder?: string;
  mealOrder?: string;
  mealId?: string;
  isSection?: boolean;
  /** legacy key, migrated to listOrder */
  order?: string;
  [key: string]: unknown;
}

export function safeParseRank(value: unknown): LexoRank | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return LexoRank.parse(value);
  } catch {
    return null;
  }
}

/** The highest valid rank for `field`, or null when there is none. */
export function maxRank(items: RankableItem[], field: RankField = 'listOrder'): LexoRank | null {
  let max: LexoRank | null = null;
  for (const item of items) {
    const rank = safeParseRank(item[field]);
    if (rank && (!max || rank.compareTo(max) > 0)) max = rank;
  }
  return max;
}

/** A rank that sorts after every existing item. */
export function nextRank(items: RankableItem[], field: RankField = 'listOrder'): LexoRank {
  const max = maxRank(items, field);
  return max ? max.genNext() : LexoRank.middle();
}

/**
 * Repairs `field` across `items`, in place, preserving each item's position.
 *
 * `prev` is the running MAXIMUM valid rank seen so far rather than the previous
 * array element, so a persisted array that isn't already sorted by rank can't
 * push a repaired item to an arbitrary spot. On an already-sorted array this is
 * identical to using the previous element.
 */
function repairRanksInPlace(items: RankableItem[], field: RankField): boolean {
  let changed = false;
  let prev: LexoRank | null = null;
  const seen = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let rank = safeParseRank(item[field]);

    // A rank already taken by an earlier item is as broken as an unparseable
    // one: the tie falls back to array order, which differs per client, so two
    // devices render the list differently and never converge. Note we only
    // reject exact DUPLICATES — a rank that merely sorts before its predecessor
    // is fine, because the stored array is not guaranteed to be in rank order.
    if (rank && seen.has(rank.toString())) rank = null;

    if (!rank) {
      let next: LexoRank | null = null;
      for (let j = i + 1; j < items.length; j++) {
        const candidate = safeParseRank(items[j]![field]);
        if (candidate && (!prev || candidate.compareTo(prev) > 0)) {
          next = candidate;
          break;
        }
      }
      if (prev && next) rank = prev.between(next);
      else if (prev) rank = prev.genNext();
      else if (next) rank = next.genPrev();
      else rank = LexoRank.middle();

      item[field] = rank.toString();
      changed = true;
    }

    seen.add(rank.toString());
    if (!prev || rank.compareTo(prev) > 0) prev = rank;
  }

  return changed;
}

/**
 * Validation/repair for a list's items[].
 * - drops null/non-object entries (RTDB array holes)
 * - migrates the legacy `order` key to `listOrder`
 * - replaces any `listOrder` that doesn't parse as a LexoRank (e.g. the literal
 *   'NEEDS-RANK' older clients persisted)
 * - ensures meal-ingredient items have a parseable `mealOrder`
 *
 * Does NOT mutate its input — items are shallow-cloned — so callers can compare
 * the result against the original, and unknown item fields (overrideQuantity,
 * overrideBase, ...) are carried through untouched.
 */
export function sanitizeItems(rawItems: unknown): { items: RankableItem[]; changed: boolean } {
  const source = Array.isArray(rawItems)
    ? rawItems
    : rawItems && typeof rawItems === 'object'
      ? Object.values(rawItems as Record<string, unknown>)
      : [];

  const kept = source.filter((i): i is RankableItem => !!i && typeof i === 'object');
  let changed = kept.length !== source.length;

  // Clone so repair never mutates the caller's objects.
  const items: RankableItem[] = kept.map((i) => ({ ...i }));

  for (const item of items) {
    if (item.listOrder === undefined && typeof item.order === 'string') {
      item.listOrder = item.order;
      delete item.order;
      changed = true;
    }
  }

  if (repairRanksInPlace(items, 'listOrder')) changed = true;

  // Meal ingredients are ordered within their meal via mealOrder.
  const mealGroups = new Map<string, RankableItem[]>();
  for (const item of items) {
    if (item.mealId && !item.isSection) {
      const group = mealGroups.get(item.mealId) ?? [];
      group.push(item);
      mealGroups.set(item.mealId, group);
    }
  }
  for (const group of mealGroups.values()) {
    if (repairRanksInPlace(group, 'mealOrder')) changed = true;
  }

  return { items, changed };
}

/**
 * The rank an item should get when inserted directly after `anchorIndex` within
 * `group`. Falls back to the nearest neighbour that actually has a parseable
 * rank, and finally to max+next — never LexoRank.middle(), which would silently
 * relocate the new item to the middle of the group.
 */
export function rankAfter(
  group: RankableItem[],
  anchorIndex: number,
  field: RankField = 'listOrder'
): LexoRank {
  let before: LexoRank | null = null;
  for (let i = anchorIndex; i >= 0; i--) {
    const r = safeParseRank(group[i]?.[field]);
    if (r) { before = r; break; }
  }

  let after: LexoRank | null = null;
  for (let i = anchorIndex + 1; i < group.length; i++) {
    const r = safeParseRank(group[i]?.[field]);
    if (r && (!before || r.compareTo(before) > 0)) { after = r; break; }
  }

  if (before && after) return before.between(after);
  if (before) return before.genNext();
  if (after) return after.genPrev();
  return nextRank(group, field);
}
