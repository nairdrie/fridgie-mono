// LexoRank helpers now live in packages/shared so client and server repair
// invalid ranks IDENTICALLY. Previously this file pushed every unrankable item
// to the bottom of the list while the server interpolated it in place, so the
// two sides produced different orderings for the same stored list.

import type { Item } from '@/types/types';
import { maxRank, nextRank, sanitizeItems } from '@fridgie/shared/rank';
import type { LexoRank } from 'lexorank';

export { rankAfter, safeParseRank } from '@fridgie/shared/rank';

/** The highest valid listOrder among items, or null when there is none. */
export function maxListRank(items: Item[]): LexoRank | null {
  return maxRank(items as any[], 'listOrder');
}

/** A listOrder that sorts after every existing item. */
export function nextListRank(items: Item[]): LexoRank {
  return nextRank(items as any[], 'listOrder');
}

/**
 * Repairs items whose listOrder is missing or unparseable, preserving each
 * item's position — the same algorithm the server applies on write.
 * Returns the same array reference when nothing needed repair.
 */
export function sanitizeListOrders(items: Item[]): Item[] {
  const { items: repaired, changed } = sanitizeItems(items);
  return changed ? (repaired as unknown as Item[]) : items;
}
