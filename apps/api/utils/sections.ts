// Filing items into the aisle headings of a list that is already sorted.
//
// The full sort (`categorizeItems`) throws the list away and rebuilds it, which
// is right when the user asks for "sort by category" and wrong for the one item
// they just typed: it re-decides the aisle of every row, remakes every heading,
// and does it on every single add. This places just the named items and leaves
// the rest of the list exactly as it was.
//
// Pure and Firebase-free so it can be unit tested directly.

import { LexoRank } from 'lexorank';
import { v4 as uuid } from 'uuid';
import { nextRank } from './rank';

export interface PlaceableItem {
  id: string;
  text?: string;
  isSection?: boolean;
  listOrder?: string;
  section?: string;
  [key: string]: unknown;
}

/** Section names sort as written — the same comparison the full sort uses. */
export const compareSections = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** A real, categorizable row: not a section header, and not blank. */
export const isRealItem = (i: any): boolean =>
  !i?.isSection && String(i?.text ?? '').trim() !== '';

/**
 * Blank placeholder rows must survive categorization without being treated as
 * uncategorizable — otherwise they get swept into a spurious "Other" section on
 * every single run.
 */
export const isBlankItem = (i: any): boolean =>
  !i?.isSection && String(i?.text ?? '').trim() === '';

const sameSection = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

interface Group {
  /** The heading row, or null for rows sitting above the first heading. */
  header: PlaceableItem | null;
  name: string;
  items: PlaceableItem[];
}

/**
 * Splits a rank-ordered list into its aisles. Rows above the first heading form
 * an unnamed leading group; every other row belongs to the heading above it.
 */
function groupBySection(ordered: PlaceableItem[]): Group[] {
  const groups: Group[] = [{ header: null, name: '', items: [] }];

  for (const item of ordered) {
    if (item.isSection) {
      groups.push({ header: item, name: String(item.text ?? '').trim(), items: [] });
    } else {
      groups[groups.length - 1]!.items.push(item);
    }
  }

  return groups;
}

/**
 * Moves each item in `placements` under its section heading, creating the
 * heading — in alphabetical position among the ones already there — when the
 * list does not have it yet. Everything else keeps its position.
 *
 * An item already sitting in the right aisle is left exactly where it is rather
 * than being moved to the bottom of it, so re-filing after an edit (fixing a
 * typo re-files the row) doesn't make the row jump.
 *
 * Returns a fresh, fully ranked array. Blank placeholder rows are pushed to the
 * end so they stay outside every section, and headings left empty are dropped.
 */
export function placeItems(
  items: PlaceableItem[],
  placements: Map<string, string>,
): PlaceableItem[] {
  const ordered = [...items].sort((a, b) =>
    String(a.listOrder ?? '').localeCompare(String(b.listOrder ?? '')),
  );

  const blanks = ordered.filter(isBlankItem);
  const groups = groupBySection(ordered.filter((i) => !isBlankItem(i)));

  const findGroup = (name: string) => groups.find((g) => g.header && sameSection(g.name, name));

  const createGroup = (name: string): Group => {
    const group: Group = {
      header: { id: uuid(), text: name, checked: false, isSection: true, listOrder: '' },
      name,
      items: [],
    };
    // Directly after the LAST heading that sorts before this one, rather than
    // before the first that sorts after it. On an alphabetical list — what the
    // full sort leaves behind — the two are the same. On a list whose headings
    // are not in order, this appends near the end instead of teleporting the new
    // aisle to the top on the strength of one out-of-place heading.
    let at = groups.length;
    for (let i = groups.length - 1; i > 0; i--) {
      if (groups[i]!.header && compareSections(groups[i]!.name, name) < 0) break;
      at = i;
    }
    groups.splice(at, 0, group);
    return group;
  };

  for (const [itemId, sectionName] of placements) {
    const name = sectionName.trim();
    if (!name) continue;

    const from = groups.find((g) => g.items.some((i) => i.id === itemId));
    if (!from) continue;
    // Already in the right aisle: leave the row alone rather than relocating it
    // to the bottom of the aisle it is already in.
    if (from.header && sameSection(from.name, name)) continue;

    const [item] = from.items.splice(
      from.items.findIndex((i) => i.id === itemId),
      1,
    );
    (findGroup(name) ?? createGroup(name)).items.push(item!);
  }

  let rank = LexoRank.middle();
  const nextRank = () => {
    const value = rank.toString();
    rank = rank.genNext();
    return value;
  };

  const result: PlaceableItem[] = [];
  for (const group of groups) {
    // A heading with nothing under it is noise; the leading group has no
    // heading to drop, so it only disappears when it empties out.
    if (group.items.length === 0) continue;

    if (group.header) result.push({ ...group.header, listOrder: nextRank() });
    for (const item of group.items) {
      const filed = { ...item, listOrder: nextRank() };
      if (group.header) filed.section = group.name;
      else delete filed.section;
      result.push(filed);
    }
  }

  for (const blank of blanks) {
    const { section, ...rest } = blank;
    result.push({ ...rest, listOrder: nextRank() });
  }

  return result;
}

/**
 * Restores anything on `stored` that `filed` never saw.
 *
 * Categorizing reads the list, thinks about it — a model call, sometimes
 * seconds of it — and writes the answer back over the whole array. Another
 * member of the group adding an item in that window would have it silently
 * deleted by the write. Their rows go on the end instead, unfiled, and the next
 * pass puts them in an aisle.
 *
 * Rows in `filed` but not in `stored` are KEPT: the caller sends its own
 * unsaved edits to be categorized, so an id the database has not seen yet is far
 * more likely to be one of those than one somebody else deleted.
 */
export function keepUnanswered(
  filed: PlaceableItem[],
  stored: { id?: unknown; [key: string]: unknown }[],
): PlaceableItem[] {
  const answered = new Set(filed.map((i) => i.id));
  const missed = stored.filter(
    (i): i is PlaceableItem => !!i && typeof i.id === 'string' && !answered.has(i.id),
  );
  if (missed.length === 0) return filed;

  let rank = nextRank(filed);
  return [
    ...filed,
    ...missed.map((item) => {
      const listOrder = rank.toString();
      rank = rank.genNext();
      return { ...item, listOrder };
    }),
  ];
}
