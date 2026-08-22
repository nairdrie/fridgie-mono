// Three-way merge for a list document — the single implementation used by BOTH
// apps, for the same reason rank.ts is shared: two copies would resolve the
// same conflict differently and the devices would never converge.
//
// WHY THIS EXISTS
//
// A list is saved as a whole document guarded by `rev`, so a save built on a
// stale snapshot is rejected with 409. The client used to "rebase" by adopting
// the server's document wholesale, which throws away every local change. Online
// that costs a keystroke. Offline — a phone in a supermarket with no bars — it
// costs the entire shop, because one teammate adding milk at home invalidates
// twenty minutes of checking things off.
//
// So the unit of conflict is the ROW, not the document, and within a row it is
// the FIELD. Two people editing the same list almost never touch the same field
// of the same row; when they do, the newer edit wins.
//
// THE RULES
//
//   both sides added rows          both survive (ids are uuids, adds can't collide)
//   one side changed a field       that side wins outright, no timestamp needed
//   both changed the SAME field    newer `updatedAt` wins; ties go to remote
//   one side deleted the row       see below
//
// Deletion is resolved structurally rather than by timestamp: a row in `base`
// and missing from one side was deleted by that side. Whether the delete sticks
// depends on what the OTHER side did to it:
//
//   nothing, or a SOFT field only  the delete stands
//   a HARD field                   the row comes back, carrying that edit
//
// Soft means checking it off, dragging it, or the server filing it into an
// aisle. Hard means renaming it or changing its quantity. The distinction is
// the difference between "I already have this in my cart" — which must not
// resurrect something a housemate deliberately removed — and "I renamed this to
// 2% milk", which is somebody actively wanting the row to exist.
//
// Environment-neutral, per the rules in this package's README: pure
// string/number logic, no Bun, no Node built-ins, no react-native, no firebase.

/** A row this module can merge. Open — unknown keys are carried through. */
export interface MergeableRow {
  id?: string;
  isSection?: boolean;
  text?: string;
  name?: string;
  /**
   * Wall-clock stamp of the last LOCAL edit to this row, set by whichever
   * client made the change. Only ever consulted to break a genuine
   * same-field conflict, so clock skew between two phones can at worst pick
   * the wrong side of a collision that is already vanishingly rare — it can
   * never lose a row or resurrect one.
   */
  updatedAt?: number;
  [key: string]: unknown;
}

export type Side = 'local' | 'remote';

/**
 * A field where BOTH sides made a change and one had to be dropped. Only
 * emitted when `local` lost — a conflict the local user won needs no telling,
 * because the result is what they already see on screen.
 */
export interface FieldConflict {
  /** Row id in the merged output. */
  id: string;
  /** The row's text/name, for a user-facing notice. */
  label: string;
  field: string;
  /** Always 'remote' today; carried explicitly so the shape survives a rule change. */
  winner: Side;
  localValue: unknown;
  remoteValue: unknown;
}

export interface MergeOutcome<T> {
  rows: T[];
  conflicts: FieldConflict[];
}

export interface MergeOptions {
  /**
   * Fields whose local change does NOT bring back a row the other side
   * deleted. Everything not listed here is "hard".
   */
  softFields?: readonly string[];
  /** Fields excluded from comparison entirely — bookkeeping, not content. */
  ignoredFields?: readonly string[];
  /** Which side takes a field whose `updatedAt` stamps are equal. */
  tieBreak?: Side;
}

/**
 * Item fields that must not resurrect a row somebody else deleted.
 *
 * `stapleOverride` is soft for the same reason `checked` is: promoting a staple
 * back into the list is a statement about this shop, not about wanting the row
 * to exist. If a housemate deliberately removed it, my "actually we're out of
 * this" must not bring it back.
 */
export const SOFT_ITEM_FIELDS = ['checked', 'listOrder', 'mealOrder', 'section', 'stapleOverride'] as const;

/** Meal fields that must not resurrect a meal somebody else deleted. */
export const SOFT_MEAL_FIELDS = ['addedToCookbook'] as const;

/** Never compared: bookkeeping the merge itself maintains. */
const ALWAYS_IGNORED = ['updatedAt'] as const;

/**
 * RTDB stores an absent key by dropping it and hands some back as null, so the
 * two are the same value as far as a diff is concerned. Without this, a round
 * trip through the database registers as an edit on every optional field.
 */
function norm(value: unknown): unknown {
  return value === null ? undefined : value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(norm(a), norm(b));
}

function stampOf(row: MergeableRow | undefined): number {
  return typeof row?.updatedAt === 'number' ? row.updatedAt : 0;
}

function labelOf(row: MergeableRow | undefined): string {
  if (!row) return '';
  const text = typeof row.text === 'string' ? row.text : '';
  const name = typeof row.name === 'string' ? row.name : '';
  return (text || name).trim();
}

/**
 * How a row is recognised across the three sides.
 *
 * Ordinary rows are their `id` — a uuid minted once by whoever created them.
 * SECTION HEADINGS ARE NOT: the server mints a fresh uuid every time it
 * categorizes (see categorize.ts), so the same "Produce" heading has a
 * different id in every snapshot. Keyed by id, a merge would keep both and the
 * list would grow a duplicate heading on every reconnect. They are keyed by
 * their label instead, which is what actually identifies them.
 */
function identify(row: MergeableRow): string {
  if (row.isSection) return `section:${labelOf(row).toLowerCase()}`;
  return `id:${row.id ?? ''}`;
}

function index<T extends MergeableRow>(rows: readonly T[] | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    // First occurrence wins: a document that already contains two headings with
    // the same label must not have the merge collapse into the later one.
    const key = identify(row);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

/** Fields that differ between a row and its base. Empty when nothing changed. */
function changedFields(
  base: MergeableRow | undefined,
  row: MergeableRow | undefined,
  ignored: ReadonlySet<string>
): Set<string> {
  const changed = new Set<string>();
  if (!row) return changed;
  const keys = new Set<string>([...Object.keys(base ?? {}), ...Object.keys(row)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (!sameValue(base?.[key], row[key])) changed.add(key);
  }
  return changed;
}

/**
 * Field-by-field diff3 for a row present on both sides.
 *
 * The timestamp is only reached for a field BOTH sides moved off the same base
 * value. Everything else resolves structurally, which is what keeps two people
 * working on one list from ever fighting: renaming a row while somebody else
 * checks it off is not a conflict at all, and is not treated as one.
 */
function mergeRow(
  base: MergeableRow | undefined,
  local: MergeableRow,
  remote: MergeableRow,
  ignored: ReadonlySet<string>,
  tieBreak: Side
): { row: MergeableRow; conflicts: FieldConflict[] } {
  const conflicts: FieldConflict[] = [];
  // Start from remote so any key neither side is known to have touched — a
  // field a newer build writes and this one has never heard of — survives.
  const row: MergeableRow = { ...remote };

  const localStamp = stampOf(local);
  const remoteStamp = stampOf(remote);
  const localWinsTies = tieBreak === 'local';
  const localIsNewer =
    localStamp > remoteStamp || (localStamp === remoteStamp && localWinsTies);

  const keys = new Set<string>([
    ...Object.keys(base ?? {}),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);

  for (const key of keys) {
    if (ignored.has(key)) continue;

    const localChanged = !sameValue(base?.[key], local[key]);
    const remoteChanged = !sameValue(base?.[key], remote[key]);

    if (!localChanged && !remoteChanged) continue;      // remote copy already right
    if (!localChanged) continue;                        // only remote moved — keep it
    if (!remoteChanged) { row[key] = local[key]; continue; }  // only local moved
    if (sameValue(local[key], remote[key])) continue;   // both moved, same way

    // A real collision: two people changed one field of one row between the
    // same two saves. Newer wins.
    if (localIsNewer) {
      row[key] = local[key];
    } else {
      conflicts.push({
        id: String(remote.id ?? local.id ?? ''),
        label: labelOf(remote) || labelOf(local),
        field: key,
        winner: 'remote',
        localValue: norm(local[key]),
        remoteValue: norm(remote[key]),
      });
    }
  }

  // The merged row carries the newer of the two stamps, so the NEXT merge
  // against it compares against when it was really last touched.
  const stamp = Math.max(localStamp, remoteStamp);
  if (stamp > 0) row.updatedAt = stamp;

  return { row, conflicts };
}

/**
 * Merges one keyed collection three ways.
 *
 * `base` is the last document this client knows it was in sync with. Its
 * absence is not fatal — the merge degrades to "keep everything, newest field
 * wins" — but with it, a change made by exactly one side is applied with no
 * appeal to timestamps at all.
 *
 * Output order follows `remote` (the document actually on the server), with
 * rows only this client has appended after. Callers re-sort by `listOrder`
 * anyway; this just keeps the result stable rather than arbitrary.
 */
export function mergeRows<T extends object>(
  baseRows: readonly T[] | undefined,
  localRows: readonly T[] | undefined,
  remoteRows: readonly T[] | undefined,
  options: MergeOptions = {}
): MergeOutcome<T> {
  // Widened here rather than in the signature so callers keep their own types.
  // `Item` and `Meal` are deliberately CLOSED in the shared contract — that is
  // what makes a typo fail typechecking — so they do not satisfy an index
  // signature, and demanding one would push the cast out to every call site.
  const base = baseRows as readonly MergeableRow[] | undefined;
  const local = localRows as readonly MergeableRow[] | undefined;
  const remote = remoteRows as readonly MergeableRow[] | undefined;

  const soft = new Set<string>([...(options.softFields ?? []), ...ALWAYS_IGNORED]);
  const ignored = new Set<string>([...(options.ignoredFields ?? []), ...ALWAYS_IGNORED]);
  const tieBreak: Side = options.tieBreak ?? 'remote';

  const B = index(base);
  const L = index(local);
  const R = index(remote);

  const rows: T[] = [];
  const conflicts: FieldConflict[] = [];
  const emitted = new Set<string>();

  const take = (key: string, row: MergeableRow) => {
    emitted.add(key);
    rows.push(row as unknown as T);
  };

  // Remote order first, then anything only this client knows about.
  const order = [...R.keys(), ...L.keys(), ...B.keys()];

  for (const key of order) {
    if (emitted.has(key)) continue;

    const b = B.get(key);
    const l = L.get(key);
    const r = R.get(key);

    // Both still have it: merge field by field.
    if (l && r) {
      const { row, conflicts: rowConflicts } = mergeRow(b, l, r, ignored, tieBreak);
      conflicts.push(...rowConflicts);
      take(key, row);
      continue;
    }

    // Only local has it. Either this client added it, or the other side
    // deleted it.
    if (l && !r) {
      if (!b) { take(key, l); continue; }               // local add — always survives
      const changed = changedFields(b, l, ignored);
      const hardEdit = [...changed].some((f) => !soft.has(f));
      if (hardEdit) take(key, l);                        // renamed: bring it back
      // else: the remote delete stands.
      else emitted.add(key);
      continue;
    }

    // Only remote has it — mirror image of the branch above.
    if (r && !l) {
      if (!b) { take(key, r); continue; }               // remote add — always survives
      const changed = changedFields(b, r, ignored);
      const hardEdit = [...changed].some((f) => !soft.has(f));
      if (hardEdit) take(key, r);
      else emitted.add(key);
      continue;
    }

    // In base only — both sides deleted it. Agreement, nothing to do.
    emitted.add(key);
  }

  return { rows, conflicts };
}

/** The mergeable half of a list document. */
export interface MergeableList<I extends object = MergeableRow, M extends object = MergeableRow> {
  items?: I[];
  meals?: M[];
}

export interface ListMergeResult<I extends object, M extends object> {
  items: I[];
  meals: M[];
  conflicts: FieldConflict[];
  /** True when the merged result differs from `remote` — i.e. worth saving. */
  changed: boolean;
}

/**
 * Merges a whole list document. `base` is the last snapshot this client was in
 * sync with, `local` is what is on screen (including anything typed offline),
 * `remote` is the document the server rejected the save against.
 */
export function mergeListDocuments<I extends object, M extends object>(
  base: MergeableList<I, M> | null | undefined,
  local: MergeableList<I, M>,
  remote: MergeableList<I, M>,
  options: { tieBreak?: Side } = {}
): ListMergeResult<I, M> {
  const items = mergeRows<I>(base?.items, local.items, remote.items, {
    softFields: SOFT_ITEM_FIELDS,
    tieBreak: options.tieBreak,
  });
  const meals = mergeRows<M>(base?.meals, local.meals, remote.meals, {
    softFields: SOFT_MEAL_FIELDS,
    tieBreak: options.tieBreak,
  });

  return {
    items: items.rows,
    meals: meals.rows,
    conflicts: [...items.conflicts, ...meals.conflicts],
    changed:
      !rowsEqual(items.rows, remote.items ?? []) || !rowsEqual(meals.rows, remote.meals ?? []),
  };
}

/**
 * Whether two collections hold the same rows with the same content.
 *
 * Used for two things. Inside the merge it answers "did this produce anything
 * the server does not already have" — when it did not, the client adopts the
 * remote document and skips the write entirely, which is the common case for a
 * reconnect where only the other person had made changes. Outside it, the
 * client uses the same comparison to tell a genuine local edit from merely
 * having rendered what the server just sent, which is what stops two clients
 * echoing saves at each other.
 *
 * `updatedAt` is deliberately excluded: it is bookkeeping, and two rows that
 * differ only in when they were stamped are the same row.
 */
export function rowsEqual(left: readonly object[], right: readonly object[]): boolean {
  const a = left as readonly MergeableRow[];
  const b = right as readonly MergeableRow[];
  if (a.length !== b.length) return false;
  const other = index(b);
  for (const row of a) {
    const match = other.get(identify(row));
    if (!match) return false;
    const keys = new Set<string>([...Object.keys(row), ...Object.keys(match)]);
    for (const key of keys) {
      if (key === 'updatedAt') continue;
      if (!sameValue(row[key], match[key])) return false;
    }
  }
  return true;
}

/** Whether a whole list document matches another, ignoring stamps. */
export function listsEqual<I extends object, M extends object>(
  a: MergeableList<I, M>,
  b: MergeableList<I, M>
): boolean {
  return rowsEqual(a.items ?? [], b.items ?? []) && rowsEqual(a.meals ?? [], b.meals ?? []);
}
