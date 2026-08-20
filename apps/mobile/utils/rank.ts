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
 *
 * Takes `unknown` because this is also the first thing a websocket payload
 * meets. RTDB hands back a stored array as a keyed object once it has a hole in
 * it, and the shared sanitizer already knows how to read that shape; the caller
 * checking `Array.isArray` first would throw the whole list away instead.
 *
 * Always returns an array — the same reference when the input was one and
 * nothing needed repair, so callers can still compare.
 */
export function sanitizeListOrders(items: unknown): Item[] {
  const { items: repaired, changed } = sanitizeItems(items);
  if (!changed && Array.isArray(items)) return items as Item[];
  return repaired as unknown as Item[];
}
