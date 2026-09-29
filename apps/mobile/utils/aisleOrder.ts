// The grocery list's order after a drag, keeping aisles together.
//
// A heading and the rows under it are one aisle, and an aisle moves as a unit.
// The draggable list only ever holds the rows on screen: checked items,
// staples, and everything in a folded aisle are missing from what it hands
// back. Taking that order literally would strand those rows wherever their old
// rank now falls, so each heading's hidden rows are gathered back up under it
// wherever it went.

/** A row as the grocery list draws it. Aggregated rows carry their sources. */
export interface AisleRow {
    id: string;
    text?: string;
    isSection?: boolean;
    section?: string;
    checked?: boolean;
    /** The stored items an aggregated row stands for. */
    sourceIds?: string[];
}

export interface AisleOrder<R> {
    /** Every row of `all`, in its new order. */
    ordered: R[];
    /**
     * Stored item id → aisle name, for items that were dropped under a
     * different heading. Moving a row into another aisle is filing it there by
     * hand, so it should keep that aisle when the list files again.
     */
    refiled: Map<string, string>;
}

/**
 * @param all   every row, in rank order — headings, open, checked, staples
 * @param shown the rows that were on screen, in the order the drag left them
 */
export function reorderByAisle<R extends AisleRow>(all: readonly R[], shown: readonly R[]): AisleOrder<R> {
    type Row = R;
    const onScreen = new Set(shown.map(row => row.id));

    // The aisles as they were. `null` is the run of rows above the first
    // heading. Rows waiting to be filed are not part of any aisle; they
    // live in the footer and go back on the end.
    const oldMembers = new Map<string | null, Row[]>([[null, []]]);
    const oldHeadingOf = new Map<string, string | null>();
    const hiddenHeadingsAfter = new Map<string | null, Row[]>();
    const tail: Row[] = [];
    let current: string | null = null;
    let lastShownHeading: string | null = null;
    for (const row of all) {
        if (row.isSection) {
            current = row.id;
            oldMembers.set(row.id, []);
            if (onScreen.has(row.id)) lastShownHeading = row.id;
            else {
                // A heading with nothing left to buy under it is not on
                // screen at all. It stays behind the aisle it followed.
                const list = hiddenHeadingsAfter.get(lastShownHeading) ?? [];
                list.push(row);
                hiddenHeadingsAfter.set(lastShownHeading, list);
            }
            continue;
        }
        if (!onScreen.has(row.id) && !row.section && !row.checked) {
            tail.push(row);
            continue;
        }
        oldMembers.get(current)!.push(row);
        oldHeadingOf.set(row.id, current);
    }

    // The aisles as they are now, going by what is on screen.
    const newMembers = new Map<string | null, Row[]>([[null, []]]);
    const headingOrder: Row[] = [];
    current = null;
    for (const row of shown) {
        if (row.isSection) {
            current = row.id;
            headingOrder.push(row);
            newMembers.set(row.id, []);
        } else {
            newMembers.get(current)!.push(row);
        }
    }

    // Hidden rows keep their place within their own aisle.
    const membersOf = (headingId: string | null): Row[] => {
        const members = [...(newMembers.get(headingId) ?? [])];
        (oldMembers.get(headingId) ?? []).forEach((row, index) => {
            if (!onScreen.has(row.id)) members.splice(Math.min(index, members.length), 0, row);
        });
        return members;
    };
    const ordered: Row[] = [];
    const emitHiddenHeadingsAfter = (anchor: string | null) => {
        for (const hidden of hiddenHeadingsAfter.get(anchor) ?? []) {
            ordered.push(hidden, ...(oldMembers.get(hidden.id) ?? []));
        }
    };
    ordered.push(...membersOf(null));
    emitHiddenHeadingsAfter(null);
    for (const h of headingOrder) {
        ordered.push(h, ...membersOf(h.id));
        emitHiddenHeadingsAfter(h.id);
    }
    ordered.push(...tail);

    // Rows that changed aisle take the new aisle's name.
    const refiled = new Map<string, string>();
    for (const h of headingOrder) {
        const name = (h.text ?? '').trim();
        if (!name) continue;
        for (const row of newMembers.get(h.id) ?? []) {
            if (!row.section || oldHeadingOf.get(row.id) === h.id) continue;
            for (const id of row.sourceIds ?? [row.id]) refiled.set(id, name);
        }
    }

    return { ordered, refiled };
}
