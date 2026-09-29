// Undo and redo for the grocery list, as a merge.
//
// Putting back the list as it was before a change would also take back
// everything that happened since — a housemate's edits, the filing pass. The
// step is replayed as a three-way merge instead, the same one a sync uses:
// the change from `from` to `to`, applied over the list as it is `now`.

import type { Item } from '@/types/types';
import { mergeRows, SOFT_ITEM_FIELDS } from '@fridgie/shared/mergeList';

/**
 * For undo, `from` is the list just after the step and `to` the list just
 * before it; redo swaps them.
 */
export function replayStep(from: readonly Item[], to: readonly Item[], now: readonly Item[]): Item[] {
    return mergeRows<Item>(from, to, now, { softFields: SOFT_ITEM_FIELDS, tieBreak: 'local' }).rows;
}
