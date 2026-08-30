// Which of a list's aisle headings still have something under them.
//
// (Distinct from `apps/api/utils/sections.ts`, which is about FILING items into
// headings. This is only about what a heading currently contains.)
//
// WHY A HEADING CAN OUTLIVE ITS CONTENTS
//
// A section is a row like any other, and it holds its items by POSITION: a row
// belongs to the nearest heading above it in rank order. Nothing points from a
// heading back down at what it contains, so removing rows — deleting a meal
// takes every ingredient it put on the list, deleting a row takes just that one
// — cannot on its own take the heading with them. What is left is "Produce"
// with nothing under it.
//
// The grocery view already hides a heading whose rows have all been checked
// off, but it deliberately keeps one with NO rows at all: that is what a
// heading the user has just typed and not filled in yet looks like, and it has
// to stay long enough to put something in it. From position alone those two are
// the same shape, which is why this is decided here — at the edit that emptied
// the heading, where the list BEFORE it is still in hand — rather than at
// render time.
//
// Environment-neutral, per the rules in this package's README: pure
// string/number logic, no Bun, no Node built-ins, no react-native, no firebase.

/** A row this module can read. Open — unknown keys are carried through. */
export interface SectionRow {
  id: string;
  isSection?: boolean;
  listOrder?: string;
  [key: string]: unknown;
}

/**
 * How many rows sit under each heading, keyed by heading id.
 *
 * Rank order, because that is the order the list is drawn in and the only thing
 * that says which heading a row is under — the stored array is not necessarily
 * in it. Rows above the first heading belong to no heading and are not counted.
 *
 * Every row counts, not just the ones on screen: a heading whose items are all
 * checked off still HAS them, and unchecking one has to bring the heading back.
 */
function countUnderEachSection(rows: readonly SectionRow[]): Map<string, number> {
  const ordered = [...rows].sort((a, b) =>
    String(a.listOrder ?? '').localeCompare(String(b.listOrder ?? '')),
  );

  const counts = new Map<string, number>();
  let current: string | null = null;

  for (const row of ordered) {
    if (row.isSection) {
      current = row.id;
      counts.set(row.id, 0);
    } else if (current !== null) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Returns `after` without the headings that going from `before` to `after`
 * emptied out.
 *
 * Only headings that LOST their last row are dropped. One that was already
 * empty in `before` is left alone — the user wrote it and has not filled it in
 * yet, and deleting something else on the list is not them changing their mind
 * about it.
 *
 * Returns `after` itself when nothing was emptied, so this cannot manufacture a
 * new array identity for a no-op edit.
 */
export function dropEmptiedSections<T extends SectionRow>(
  before: readonly T[],
  after: readonly T[],
): T[] {
  const had = countUnderEachSection(before);
  const has = countUnderEachSection(after);

  const emptied = new Set<string>();
  for (const [id, count] of has) {
    if (count === 0 && (had.get(id) ?? 0) > 0) emptied.add(id);
  }

  if (emptied.size === 0) return after as T[];
  return after.filter((row) => !emptied.has(row.id));
}
