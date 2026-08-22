// Marks the rows a local edit actually touched.
//
// The merge resolves almost everything structurally — a field one side changed
// and the other didn't goes to the side that changed it, no clock involved.
// The one case it cannot settle that way is two people changing the SAME field
// of the SAME row between the same two saves. `updatedAt` is what breaks that
// tie, and it is only ever read for that.
//
// It is applied by diffing the array rather than by asking each call site to
// remember, because `setItems` is threaded through GroceryListView and
// MealPlanView and used from a dozen places between them. A stamp that has to
// be remembered is a stamp that is missing from exactly the path that needed it.

interface Row {
  id?: string;
  updatedAt?: number;
  [key: string]: unknown;
}

/** Shallow content comparison, ignoring the stamp itself. */
function sameContent(a: Row, b: Row): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'updatedAt') continue;
    // null and undefined are the same absence — RTDB returns one for the other,
    // so treating them as different would restamp every optional field on
    // every render after a round trip.
    const left = a[key] ?? undefined;
    const right = b[key] ?? undefined;
    if (!Object.is(left, right)) return false;
  }
  return true;
}

/**
 * Returns `next` with `updatedAt` set on every row whose content changed.
 *
 * Returns `next` untouched when nothing did, so this cannot manufacture a new
 * array identity on every render and send the screen into a save loop. Rows
 * that are reference-identical to their previous version short-circuit, which
 * is the common case: an edit rebuilds one row and maps the rest through.
 */
export function stampEdits<T extends { id?: string; updatedAt?: number }>(
  prev: readonly T[],
  next: readonly T[],
  now = Date.now()
): T[] {
  if (prev === next) return next as T[];

  // Widened here rather than in the signature: `Item` and `Meal` are closed
  // types in the shared contract, so they do not satisfy an index signature,
  // and requiring one would make every caller cast instead.
  const before = new Map<string, Row>();
  for (const row of prev as readonly Row[]) if (row?.id) before.set(row.id, row);

  let changed = false;
  const stamped = (next as readonly Row[]).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const old = row.id ? before.get(row.id) : undefined;
    // A row that is literally the same object, or the same content, was not
    // touched by this edit — only the rows that moved get a new stamp.
    if (old === row) return row;
    if (old && sameContent(old, row)) return row;
    changed = true;
    return { ...row, updatedAt: now };
  });

  return changed ? (stamped as unknown as T[]) : (next as T[]);
}
