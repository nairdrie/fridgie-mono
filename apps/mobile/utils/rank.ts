// utils/rank.ts
//
// LexoRank helpers that tolerate invalid/missing rank strings. Older data can
// contain placeholder values like "NEEDS-RANK" (see BACKEND_HANDOFF.md §5.3),
// and LexoRank.parse throws on them.

import { Item } from '@/types/types';
import { LexoRank } from 'lexorank';

export function safeParseRank(rank: string | undefined | null): LexoRank | null {
    if (!rank) return null;
    try {
        return LexoRank.parse(rank);
    } catch {
        return null;
    }
}

/** The highest valid listOrder among items, or null when there is none. */
export function maxListRank(items: Item[]): LexoRank | null {
    let max: LexoRank | null = null;
    for (const item of items) {
        const rank = safeParseRank(item.listOrder);
        if (rank && (!max || rank.compareTo(max) > 0)) max = rank;
    }
    return max;
}

/** A listOrder that sorts after every existing item. */
export function nextListRank(items: Item[]): LexoRank {
    const max = maxListRank(items);
    return max ? max.genNext() : LexoRank.middle();
}

/**
 * Repairs items whose listOrder is missing or not a parseable LexoRank by
 * re-ranking them after the highest valid rank. Returns the same array
 * reference when nothing needed repair.
 */
export function sanitizeListOrders(items: Item[]): Item[] {
    const invalid = items.filter(i => !safeParseRank(i.listOrder));
    if (invalid.length === 0) return items;

    let rank = maxListRank(items) ?? LexoRank.middle();
    const repaired = new Map<string, string>();
    for (const item of invalid) {
        rank = rank.genNext();
        repaired.set(item.id, rank.toString());
    }
    return items.map(i => repaired.has(i.id) ? { ...i, listOrder: repaired.get(i.id)! } : i);
}
