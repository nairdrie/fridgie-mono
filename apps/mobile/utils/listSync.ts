// The sync engine: what stands between a list being edited and a list being
// saved, and what decides who wins when two people edited the same week.
//
// The save it replaces was a debounced `updateList` whose failure path was
// `console.error`. That is fine on a desk and useless in a supermarket: a
// dropped request lost the edit outright, and a 409 was "resolved" by adopting
// the server's document wholesale, throwing away everything local. This engine
// changes both halves.
//
//   NOTHING IS EVER DROPPED. A failed save leaves the list dirty and mirrored
//   to disk. It retries on a backoff, when the websocket reconnects, and when
//   the app is foregrounded — for as long as it takes.
//
//   NOTHING IS EVER CLOBBERED. A 409 is resolved by merging local against the
//   server document over their common ancestor, per-field, and re-sending the
//   result. See packages/shared/mergeList.ts for the rules.
//
// Engines are registered per list and OUTLIVE the screen. Editing next week's
// list on the train, switching back to this week, and only then finding signal
// must still save next week — so the thing holding those unsaved edits cannot
// be owned by a component that unmounted two screens ago.

import type { FieldConflict } from '@fridgie/shared/mergeList';
import { listsEqual, mergeListDocuments } from '@fridgie/shared/mergeList';
import type { Item, List, ListSort, Meal } from '@/types/types';
import { ApiError, StaleRevError, updateList } from './api';
import { isOnline, reportReachable, reportUnreachable, subscribeConnectivity } from './connectivity';
import {
  flushCache,
  peekPendingList,
  readCachedList,
  readDirtyCachedLists,
  writeCachedList,
  type CachedList,
  type ListSnapshot,
} from './listCache';

/**
 * Department order, always. A grocery list is walked aisle by aisle, so filing
 * is what the list does rather than a mode to be picked — there is no sort
 * picker any more, and nothing left to store a per-list choice for. Still
 * written on every save so the stored document says what the order actually is,
 * including for lists left on the old `custom` setting.
 *
 * Lives here rather than on the list screen because the engine is what writes
 * it, and it must still be written by a flush that happens long after that
 * screen has gone.
 */
export const LIST_SORT: ListSort = 'category';

export type SyncStatus =
  /** Everything local has reached the server. */
  | 'synced'
  /** Local edits not yet sent — debouncing, or waiting on a retry. */
  | 'pending'
  /** A save is in flight right now. */
  | 'saving'
  /** The server could not be reached; edits are held on the device. */
  | 'offline';

export interface SyncState {
  status: SyncStatus;
  /** When the on-device mirror was last written. */
  savedAt: number;
  /** Conflicts where the LOCAL edit lost, awaiting acknowledgement. */
  conflicts: FieldConflict[];
}

/** Debounce before a local edit is sent. Matches the old save effect. */
const SAVE_DEBOUNCE_MS = 500;
/** Ceiling on merge-and-retry rounds within one flush, so a hot list can't spin. */
const MAX_MERGE_ROUNDS = 5;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

const emptySnapshot = (): ListSnapshot => ({ items: [], meals: [] });

export class ListSyncEngine {
  readonly groupId: string;
  readonly listId: string;

  /** Last document the server confirmed. Null until the first sync. */
  private base: (ListSnapshot & { rev?: number }) | null = null;
  /** What is on screen. Ahead of `base` exactly when `dirty`. */
  private local: ListSnapshot = emptySnapshot();
  private dirty = false;
  /**
   * Whether this engine has ever held a real document, from disk or the wire.
   * Distinct from `base != null` because it is what decides whether a snapshot
   * is a LOAD or an UPDATE, and those are answered differently.
   */
  private loaded = false;

  private status: SyncStatus = 'synced';
  private savedAt = 0;
  private conflicts: FieldConflict[] = [];

  private inFlight = false;
  private flushAgain = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  private stateListeners = new Set<(state: SyncState) => void>();
  /** Set by the screen currently showing this list, if any. */
  private renderer: ((snapshot: ListSnapshot) => void) | null = null;

  /**
   * Private on purpose. An engine only resyncs because `flushAllDirty` sweeps
   * the REGISTRY when the connection returns, so one built with `new` would
   * hold edits it never sends — the exact failure this whole change exists to
   * prevent, reintroduced by a constructor call. `getListSyncEngine` is the
   * only way in, and it registers.
   */
  private constructor(groupId: string, listId: string) {
    this.groupId = groupId;
    this.listId = listId;
  }

  /** @internal — the registry is the only legitimate caller. */
  static create(groupId: string, listId: string): ListSyncEngine {
    return new ListSyncEngine(groupId, listId);
  }

  // ─── state plumbing ────────────────────────────────────────────────────────

  get state(): SyncState {
    return { status: this.status, savedAt: this.savedAt, conflicts: this.conflicts };
  }

  get hasUnsavedWork(): boolean {
    return this.dirty;
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Registers the screen showing this list, so a merge can put the result on
   * screen. An engine with no renderer is one whose week is not being looked
   * at; it still merges and still saves, it just has nothing to repaint.
   */
  setRenderer(renderer: (snapshot: ListSnapshot) => void): () => void {
    this.renderer = renderer;
    return () => {
      if (this.renderer === renderer) this.renderer = null;
    };
  }

  dismissConflicts(): void {
    if (this.conflicts.length === 0) return;
    this.conflicts = [];
    this.emit();
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.warn('[listSync] state listener threw', err);
      }
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private persist(): void {
    const entry: Omit<CachedList, 'savedAt'> = {
      groupId: this.groupId,
      listId: this.listId,
      base: this.base,
      local: this.local,
      dirty: this.dirty,
    };
    writeCachedList(entry);
    this.savedAt = peekPendingList(this.groupId, this.listId)?.savedAt ?? Date.now();
    this.emit();
  }

  // ─── inputs ────────────────────────────────────────────────────────────────

  /**
   * Loads the on-device mirror. Called before the network is consulted, so a
   * phone with no signal paints the real list instead of a spinner over
   * nothing.
   */
  async hydrate(): Promise<ListSnapshot | null> {
    const cached = await readCachedList(this.groupId, this.listId);
    if (!cached) return null;

    // An engine that has already talked to the server knows more than the disk
    // — this is a second mount of the same week, not a cold start.
    if (this.base || this.dirty) return this.local;

    this.base = cached.base;
    this.local = { items: cached.local.items ?? [], meals: cached.local.meals ?? [] };
    this.dirty = Boolean(cached.dirty);
    this.loaded = true;
    this.savedAt = cached.savedAt ?? 0;
    this.setStatus(this.dirty ? (isOnline() ? 'pending' : 'offline') : 'synced');
    if (this.dirty) this.scheduleFlush(0);
    return this.local;
  }

  /**
   * A snapshot arrived from the websocket (or a fresh GET).
   *
   * Returns what the screen should now show, or null when there is nothing to
   * repaint. This is where a remote edit meets an unsaved local one, and the
   * three cases are genuinely different:
   *
   *   our own echo   already ours — adopt the revision, repaint nothing.
   *                  Repainting is what made two clients ping-pong saves.
   *   nothing local  adopt it wholesale. The common case.
   *   local edits    MERGE. The old code deferred this behind a 1.2s "user is
   *                  typing" window and hoped the next save's 409 sorted it
   *                  out. Merging is what the 409 path should always have done,
   *                  so doing it here costs nothing and means a snapshot
   *                  landing mid-keystroke can no longer take the keystroke
   *                  with it — you changed `text`, they didn't, so yours wins
   *                  outright with no appeal to a clock.
   */
  applyRemote(remote: List, ownClientId: string): ListSnapshot | null {
    if (!remote) return null;

    const incoming: ListSnapshot = {
      items: Array.isArray(remote.items) ? remote.items : valuesOf<Item>(remote.items),
      meals: Array.isArray(remote.meals) ? remote.meals : valuesOf<Meal>(remote.meals),
    };

    // Revisions only go up. A snapshot behind what we already hold is a
    // straggler from a socket that reconnected out of order.
    if (
      typeof remote.rev === 'number' &&
      typeof this.base?.rev === 'number' &&
      remote.rev < this.base.rev
    ) {
      return null;
    }

    // Our own write echoing back. Never re-apply it ONCE LOADED — repainting
    // an echo is what made two clients ping-pong saves at each other.
    //
    // The `loaded` guard is not decoration. `lastClientId` is stored ON the
    // document, so the first snapshot of a week this session already wrote to —
    // open week A, edit it, switch to B, switch back — still carries our id.
    // Hard-ignoring that one leaves the previous week's contents on screen
    // under this week's heading. Normally the on-device mirror has already
    // painted the right thing by now, but it will not have if the cache was
    // cleared, and "usually covered" is not covered.
    if (this.loaded && remote.lastClientId === ownClientId) {
      this.base = { ...incoming, rev: remote.rev };
      this.persist();
      return null;
    }

    if (!this.dirty) {
      this.base = { ...incoming, rev: remote.rev };
      this.local = incoming;
      this.loaded = true;
      this.persist();
      return incoming;
    }

    const merged = mergeListDocuments(this.base, this.local, incoming);
    this.base = { ...incoming, rev: remote.rev };
    this.local = { items: merged.items, meals: merged.meals };
    this.dirty = merged.changed;
    this.loaded = true;
    this.recordConflicts(merged.conflicts);
    this.persist();
    if (this.dirty) this.scheduleFlush(SAVE_DEBOUNCE_MS);
    else this.setStatus('synced');
    return this.local;
  }

  /**
   * A local edit. Mirrored to disk immediately, sent after the debounce.
   *
   * The screen calls this on every change to `items`/`meals`, including the
   * ones IT made because a snapshot arrived — React cannot tell those apart,
   * and having the screen try to (a boolean ref flipped around every remote
   * apply) is exactly the sort of bookkeeping that goes wrong when a second
   * snapshot lands mid-apply. Comparing against the confirmed base answers the
   * question directly: a state that matches what the server already has is not
   * an edit, whoever produced it. Without this the two clients would echo
   * saves at each other indefinitely.
   */
  recordLocal(snapshot: ListSnapshot): void {
    this.local = snapshot;

    if (this.base && listsEqual(snapshot, this.base)) {
      if (!this.dirty) return;
      this.dirty = false;
      this.clearRetry();
      this.persist();
      this.setStatus('synced');
      return;
    }

    this.dirty = true;
    this.persist();
    this.setStatus(isOnline() ? 'pending' : 'offline');
    this.scheduleFlush(SAVE_DEBOUNCE_MS);
  }

  /**
   * Adopts a document the server just wrote on our behalf — the categorize
   * endpoint, which commits its own revision. Without this the very next save
   * would arrive stale and be merged against a document it already agrees
   * with, for no reason.
   */
  adoptServerWrite(snapshot: ListSnapshot, rev?: number): void {
    this.local = snapshot;
    this.base = { ...snapshot, rev };
    this.dirty = false;
    this.loaded = true;
    this.persist();
    this.setStatus('synced');
  }

  /**
   * Puts back the local value of every field that lost a merge.
   *
   * This is the "Undo" on the notice the user gets. It is a fresh edit rather
   * than a rollback — the fields are re-applied to the CURRENT document and
   * stamped now, so it cannot resurrect anything else that has happened since,
   * and the other person's next edit can win over it in turn. Undoing a merge
   * by restoring an old snapshot would quietly delete whatever arrived in
   * between.
   */
  undoConflicts(): void {
    if (this.conflicts.length === 0) return;
    const now = Date.now();

    const restore = <T extends { id?: string }>(rows: T[]): T[] =>
      rows.map((row) => {
        const mine = this.conflicts.filter((c) => c.id && c.id === row.id);
        if (mine.length === 0) return row;
        const restored: Record<string, unknown> = { ...row, updatedAt: now };
        for (const conflict of mine) restored[conflict.field] = conflict.localValue;
        return restored as T;
      });

    this.local = {
      items: restore(this.local.items),
      meals: restore(this.local.meals),
    };
    this.conflicts = [];
    this.dirty = true;
    this.renderer?.(this.local);
    this.persist();
    this.setStatus(isOnline() ? 'pending' : 'offline');
    void this.flush();
  }

  private recordConflicts(conflicts: FieldConflict[]): void {
    if (conflicts.length === 0) return;
    // Newest first, and capped: this feeds a toast, not an audit log.
    this.conflicts = [...conflicts, ...this.conflicts].slice(0, 10);
  }

  // ─── flushing ──────────────────────────────────────────────────────────────

  private scheduleFlush(delay: number): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, delay);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retryAttempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  /**
   * Stops everything pending. Called when engines are torn down at sign-out:
   * without it the debounce and retry timers keep firing afterwards and
   * re-POST the previous account's list, against an auth token that has since
   * been replaced.
   */
  dispose(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.clearRetry();
    this.stateListeners.clear();
    this.renderer = null;
    this.dirty = false;
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
  }

  /** Sends local to the server, merging and re-sending as often as it takes. */
  async flush(): Promise<void> {
    if (!this.dirty) {
      this.setStatus('synced');
      return;
    }

    // Never send without a confirmed base.
    //
    // A save is a WHOLE-DOCUMENT write. With no base there is no `rev` to send,
    // so the server applies it last-write-wins — and with no base the local
    // document is whatever this device happens to hold, which for a week opened
    // for the first time with no signal is an empty list. That save would
    // silently delete the week.
    //
    // Waiting costs nothing and is exactly right: when the connection returns,
    // the socket delivers a snapshot, `applyRemote` merges these edits into it
    // (with no base the merge keeps everything from both sides, deleting
    // nothing), and the flush that follows carries the server's own revision.
    if (!this.base) {
      this.setStatus(isOnline() ? 'pending' : 'offline');
      return;
    }
    if (this.inFlight) {
      // Coalesce: whatever changed during the in-flight save goes out after it.
      this.flushAgain = true;
      return;
    }

    this.inFlight = true;
    this.setStatus('saving');
    try {
      for (let round = 0; round < MAX_MERGE_ROUNDS; round++) {
        // Captured by reference. After the await, comparing these against
        // `this.local` is what tells us whether the user typed while the
        // request was in the air — and so whether the save we just confirmed
        // actually covers everything.
        const sending = this.local;

        try {
          const res = await updateList(
            this.groupId,
            this.listId,
            { items: sending.items, meals: sending.meals, sort: LIST_SORT },
            this.base?.rev
          );
          reportReachable();
          this.base = { ...sending, rev: res?.rev };
          this.dirty = this.local !== sending;
          this.clearRetry();
          this.persist();
          this.setStatus(this.dirty ? 'pending' : 'synced');
          return;
        } catch (err) {
          if (err instanceof StaleRevError) {
            reportReachable();
            const theirs: ListSnapshot = {
              items: Array.isArray(err.list?.items) ? err.list.items : [],
              meals: Array.isArray(err.list?.meals) ? err.list.meals : [],
            };
            const merged = mergeListDocuments(this.base, this.local, theirs);
            this.base = { ...theirs, rev: err.rev };
            this.local = { items: merged.items, meals: merged.meals };
            this.recordConflicts(merged.conflicts);
            this.renderer?.(this.local);
            this.persist();

            // The other side's document already contains everything of ours.
            // Nothing to send; saving anyway would just bump the revision and
            // wake every other client for no change.
            if (!merged.changed) {
              this.dirty = false;
              this.clearRetry();
              this.setStatus('synced');
              return;
            }
            continue; // re-send the merged document against their revision
          }

          if (isTransportFailure(err)) {
            reportUnreachable();
            this.setStatus('offline');
            this.scheduleRetry();
            return;
          }

          // A real server error (403, 404, 500). Retrying immediately would
          // hammer it; the edits stay dirty on disk either way.
          console.error('[listSync] save failed', err);
          this.setStatus('pending');
          this.scheduleRetry();
          return;
        }
      }

      // Merged five times and still losing the race. Back off rather than
      // spin — nothing is lost, the document is still on disk and dirty.
      console.warn('[listSync] gave up merging after', MAX_MERGE_ROUNDS, 'rounds');
      this.setStatus('pending');
      this.scheduleRetry();
    } finally {
      this.inFlight = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.scheduleFlush(SAVE_DEBOUNCE_MS);
      }
    }
  }
}

/**
 * A transport failure — the server was not reached at all.
 *
 * `authorizedFetch` collapses a timeout, a DNS failure and a dropped
 * connection into ApiError with status 0, which is exactly the set of things
 * that should park an edit for later rather than report it as broken.
 */
function isTransportFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

/** RTDB hands a stored array back as a keyed object once it has a hole in it. */
function valuesOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

// ─────── REGISTRY ────────────────────────────────────────────────────────────

const engines = new Map<string, ListSyncEngine>();
const engineKey = (groupId: string, listId: string) => `${groupId}:${listId}`;

export function getListSyncEngine(groupId: string, listId: string): ListSyncEngine {
  const key = engineKey(groupId, listId);
  let engine = engines.get(key);
  if (!engine) {
    engine = ListSyncEngine.create(groupId, listId);
    engines.set(key, engine);
  }
  return engine;
}

/** Every list with edits the server has not seen. */
export function enginesWithUnsavedWork(): ListSyncEngine[] {
  return [...engines.values()].filter((e) => e.hasUnsavedWork);
}

/**
 * Pushes every dirty list. Wired to the websocket reconnecting, to the
 * connection coming back, and to the app being foregrounded — the three
 * moments when a save that has been failing might start working.
 */
export async function flushAllDirty(): Promise<void> {
  await Promise.all(enginesWithUnsavedWork().map((engine) => engine.flush()));
}

/**
 * Re-creates an engine for every list left dirty on disk, and pushes them.
 *
 * Called once at startup. The case this exists for: edits made in a shop with
 * no signal, then the app killed by the OS before the connection came back.
 * The edits are safe on disk either way — this is what stops them waiting for
 * the user to re-open that particular week before they are sent.
 */
export async function resumeUnsavedWork(): Promise<void> {
  const dirty = await readDirtyCachedLists();
  if (dirty.length === 0) return;
  console.log(`[listSync] resuming ${dirty.length} list(s) with unsaved edits`);
  await Promise.all(
    dirty.map(async (entry) => {
      const engine = getListSyncEngine(entry.groupId, entry.listId);
      await engine.hydrate();
    })
  );
}

export async function shutdownSync(): Promise<void> {
  await flushCache();
}

/** Dropped on sign-out, so the next account starts clean. */
export function resetSyncEngines(): void {
  for (const engine of engines.values()) engine.dispose();
  engines.clear();
}

// A reconnection is the one event that is always worth acting on: it is the
// only reason a save that has been failing would now succeed. Registered once,
// at module load, rather than per screen — the lists that need flushing are
// usually not the one being looked at.
subscribeConnectivity((online) => {
  if (online) void flushAllDirty();
});
