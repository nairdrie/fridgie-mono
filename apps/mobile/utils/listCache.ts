// A durable, timestamped mirror of what is on screen.
//
// Everything the list screen knows used to live in React state and nowhere
// else, which meant a phone with no signal had no list at all: getLists() threw,
// the tab layout swapped the whole UI for ConnectionError, and any edit made
// before the app was killed had simply never existed. That is the worst place
// for this app to be — a grocery list is used in a supermarket, which is where
// the signal is.
//
// So every list is mirrored to AsyncStorage as it is edited. Three things are
// stored per list, and the middle one is the whole point:
//
//   base   the last server document we KNOW we were in sync with
//   local  what is on screen, including anything typed with no signal
//   dirty  whether local has run ahead of base
//
// `base` is what makes a real three-way merge possible when the connection
// comes back. Without it a reconnect can only ask "which document is newer",
// and the answer throws away one side's work. With it, mergeList can tell a
// row somebody deleted from a row you never had, and a field you changed from
// a field you merely inherited.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Group, Item, ListSummary, Meal } from '@/types/types';

/** Bumped only when the stored shape changes incompatibly. Old keys are dropped. */
const SCHEMA = 1;
const PREFIX = `fridgie:cache:v${SCHEMA}:`;

const listKey = (groupId: string, listId: string) => `${PREFIX}list:${groupId}:${listId}`;
const summariesKey = (groupId: string) => `${PREFIX}weeks:${groupId}`;
const GROUPS_KEY = `${PREFIX}groups`;

/** How many weeks to keep per group. Old weeks are read-only history. */
const MAX_CACHED_LISTS_PER_GROUP = 12;

export interface ListSnapshot {
  items: Item[];
  meals: Meal[];
}

export interface CachedList {
  groupId: string;
  listId: string;
  /**
   * The last document the server confirmed, at `rev`. Null before the first
   * successful sync — the merge degrades to keep-everything, which is right:
   * with no confirmed common ancestor, nothing can safely be called deleted.
   */
  base: (ListSnapshot & { rev?: number }) | null;
  /** What is on screen. Ahead of `base` exactly when `dirty`. */
  local: ListSnapshot;
  /** True while local edits have not reached the server. */
  dirty: boolean;
  /** When this mirror was last written, for "saved on this phone at ...". */
  savedAt: number;
}

/**
 * AsyncStorage must never take the screen down.
 *
 * A cache is an optimisation with a correctness story attached, not a source of
 * truth — a device that is out of disk, or a store that fails to open, should
 * degrade to the old online-only behaviour rather than crash the list. Every
 * read answers null on failure and every write swallows.
 */
async function safeGet(key: string): Promise<unknown> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('[listCache] read failed', key, err);
    return null;
  }
}

async function safeSet(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('[listCache] write failed', key, err);
  }
}

// ─────── LIST DOCUMENTS ──────────────────────────────────────────────────────

export async function readCachedList(
  groupId: string,
  listId: string
): Promise<CachedList | null> {
  const value = (await safeGet(listKey(groupId, listId))) as CachedList | null;
  if (!value || typeof value !== 'object') return null;
  // A truncated or hand-edited entry is worse than none: it would be treated as
  // a confirmed base and could make the merge delete rows that still exist.
  if (!value.local || !Array.isArray(value.local.items)) return null;
  return value;
}

/**
 * Writes are DEBOUNCED and coalesced per list.
 *
 * The list screen re-renders on every keystroke, and a synchronous
 * AsyncStorage write per keystroke is the classic way to make a text field
 * stutter. The pending value is always the newest one, so coalescing loses
 * nothing, and `flushCache` forces it out at the moments that actually matter —
 * backgrounding the app, or the OS about to kill it.
 */
const pending = new Map<string, CachedList>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 250;

export function writeCachedList(entry: Omit<CachedList, 'savedAt'>): void {
  const key = listKey(entry.groupId, entry.listId);
  pending.set(key, { ...entry, savedAt: Date.now() });
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCache();
  }, FLUSH_DELAY_MS);
}

/** Forces every pending write out now. Safe to call at any time. */
export async function flushCache(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;
  const entries = [...pending.entries()];
  pending.clear();
  try {
    await AsyncStorage.multiSet(entries.map(([k, v]) => [k, JSON.stringify(v)]));
  } catch (err) {
    console.warn('[listCache] flush failed', err);
  }
}

/** The pending value for a list, if it has not been written out yet. */
export function peekPendingList(groupId: string, listId: string): CachedList | undefined {
  return pending.get(listKey(groupId, listId));
}

// ─────── GROUPS AND WEEKS ────────────────────────────────────────────────────
//
// Cached for one reason: without them a cold start with no signal cannot reach
// a list at all. AuthContext needs a group before ListContext asks for weeks,
// and ListContext needs a week before the list screen renders anything. Caching
// the list document alone would still leave the user staring at ConnectionError.

export async function readCachedGroups(): Promise<Group[] | null> {
  const value = await safeGet(GROUPS_KEY);
  return Array.isArray(value) ? (value as Group[]) : null;
}

export async function writeCachedGroups(groups: Group[]): Promise<void> {
  await safeSet(GROUPS_KEY, groups);
}

export async function readCachedSummaries(groupId: string): Promise<ListSummary[] | null> {
  const value = await safeGet(summariesKey(groupId));
  return Array.isArray(value) ? (value as ListSummary[]) : null;
}

export async function writeCachedSummaries(
  groupId: string,
  lists: ListSummary[]
): Promise<void> {
  await safeSet(summariesKey(groupId), lists);
}

// ─────── HOUSEKEEPING ────────────────────────────────────────────────────────

/**
 * Drops cached weeks beyond the newest `MAX_CACHED_LISTS_PER_GROUP`.
 *
 * A list is mirrored the moment it is opened, so a long-lived install would
 * otherwise accumulate one entry per week forever. Anything still dirty is
 * KEPT regardless of age — it holds edits the server has never seen, and
 * evicting it would be deleting the user's work to save a few kilobytes.
 */
export async function pruneCachedLists(groupId: string, keepIds: string[]): Promise<void> {
  try {
    const keep = new Set(keepIds.slice(0, MAX_CACHED_LISTS_PER_GROUP));
    const prefix = `${PREFIX}list:${groupId}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));

    const doomed: string[] = [];
    for (const key of keys) {
      const listId = key.slice(prefix.length);
      if (keep.has(listId)) continue;
      const entry = (await safeGet(key)) as CachedList | null;
      if (entry?.dirty) continue;
      doomed.push(key);
    }
    if (doomed.length) await AsyncStorage.multiRemove(doomed);
  } catch (err) {
    console.warn('[listCache] prune failed', err);
  }
}

/**
 * Every cached list that still holds edits the server has not seen.
 *
 * Read once at startup. Without it, edits made offline and then killed with the
 * app — which is what happens when iOS reclaims a backgrounded app in a
 * supermarket — would sit on disk forever: nothing would re-create a sync
 * engine for a week the user has not re-opened, so nothing would ever push
 * them. This is what makes the recovery automatic rather than dependent on the
 * user happening to navigate back.
 */
export async function readDirtyCachedLists(): Promise<CachedList[]> {
  try {
    const prefix = `${PREFIX}list:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return [];
    const pairs = await AsyncStorage.multiGet(keys);
    const dirty: CachedList[] = [];
    for (const [, raw] of pairs) {
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as CachedList;
        if (entry?.dirty && entry.local && Array.isArray(entry.local.items)) dirty.push(entry);
      } catch {
        // A single corrupt entry must not stop the others being recovered.
      }
    }
    return dirty;
  } catch (err) {
    console.warn('[listCache] dirty scan failed', err);
    return [];
  }
}

/**
 * Removes every cached entry. Called on sign-out — the next person to use this
 * phone must not find the previous account's groceries waiting for them.
 */
export async function clearCache(): Promise<void> {
  try {
    await flushCache();
    pending.clear();
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch (err) {
    console.warn('[listCache] clear failed', err);
  }
}
