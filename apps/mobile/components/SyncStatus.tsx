// The one place the app admits it is offline.
//
// This is deliberately quiet. A grocery list that keeps working with no signal
// only feels trustworthy if it does not make a fuss about it — the previous
// behaviour, replacing the entire tab with "Can't reach Fridgie", was the
// opposite and is why this exists. So:
//
//   synced   nothing at all, ever
//   saving   nothing, unless it lasts long enough to be worth mentioning
//   offline  a small pill saying the edits are on the phone, with the time
//   lost     a merge took something the user typed — the ONE case worth
//            interrupting for, because it is the only one where their work
//            actually changed under them
//
// The last is the honest half of the bargain. Merging silently is right for the
// other 99% of cases, where nothing of anyone's is lost; when something IS
// lost, saying nothing would be hiding it.
//
// WHY IT FLOATS
//
// This used to be a bar in the layout, above the list. Every appearance and
// disappearance therefore resized the list under the user's thumb: mid-scroll
// the whole pane jumped down, then back up again a couple of seconds later when
// the bar left. A status line is not worth a single pixel of the list moving,
// so nothing here occupies layout — it is an overlay, and the list never knows.
//
// There is no "Synced" confirmation any more for the same reason it was the
// worst offender: it appeared precisely when everything was fine, and cost two
// layout jumps to say so. An offline pill going away already says it.

import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import type { ListSyncEngine, SyncState } from '@/utils/listSync';

/** A save that finishes inside this window isn't worth telling anyone about. */
const SAVING_VISIBLE_AFTER_MS = 1500;

function timeOfDay(at: number): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function SyncStatus({ engine }: { engine: ListSyncEngine | null }) {
  const [state, setState] = useState<SyncState | null>(null);
  const [showSaving, setShowSaving] = useState(false);

  useEffect(() => {
    if (!engine) {
      setState(null);
      return;
    }
    return engine.subscribe(setState);
  }, [engine]);

  const status = state?.status ?? 'synced';

  // "Saving" only earns a pill if it is taking a while. Flashing it on every
  // keystroke's debounce would make a working app look like a struggling one.
  useEffect(() => {
    if (status !== 'saving') {
      setShowSaving(false);
      return;
    }
    const timer = setTimeout(() => setShowSaving(true), SAVING_VISIBLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (!engine || !state) return null;

  const conflicts = state.conflicts;

  // Everything below is absolutely positioned inside this fill, so the screen
  // it sits over lays out as if none of it were here.
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {conflicts.length > 0 ? (
        <ConflictCard
          conflicts={conflicts}
          onUndo={() => engine.undoConflicts()}
          onDismiss={() => engine.dismissConflicts()}
        />
      ) : status === 'offline' ? (
        <Pill
          icon="cloud-offline-outline"
          // The time matters here in a way it doesn't elsewhere: it is the
          // answer to "is what I typed ten minutes ago actually safe".
          text={`Offline · saved ${timeOfDay(state.savedAt) || 'on this phone'}`}
        />
      ) : showSaving ? (
        <Pill icon="sync-outline" text="Saving…" />
      ) : null}
    </View>
  );
}

/**
 * The quiet half: small, low-contrast, out of the way in the bottom corner the
 * FAB doesn't use, and untouchable — a tap meant for the list underneath must
 * reach the list.
 */
function Pill({ icon, text }: { icon: React.ComponentProps<typeof Ionicons>['name']; text: string }) {
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      style={styles.pill}
    >
      <Ionicons name={icon} size={12} color="#5b6470" />
      <Text style={styles.pillText} numberOfLines={1}>{text}</Text>
    </Animated.View>
  );
}

/**
 * The loud half. Still floating — it must not move the list either — but at the
 * top, where it reads as an alert rather than as a status, and where the
 * keyboard can't hide it.
 */
function ConflictCard({
  conflicts,
  onUndo,
  onDismiss,
}: {
  conflicts: SyncState['conflicts'];
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const first = conflicts[0];
  const others = conflicts.length - 1;
  const what = first?.label ? `"${first.label}"` : 'an item';
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(180)}
      style={styles.conflictCard}
    >
      <Ionicons name="git-merge-outline" size={16} color="#8a5a00" />
      <Text style={styles.conflictText} numberOfLines={2}>
        Someone else&apos;s change to {what} won
        {others > 0 ? ` (and ${others} more)` : ''} while you were offline.
      </Text>
      <View style={styles.actions}>
        <Pressable onPress={onUndo} hitSlop={8} accessibilityRole="button">
          <Text style={styles.undo}>Undo</Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={8} accessibilityRole="button">
          <Ionicons name="close" size={18} color="#8a5a00" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    // Bottom LEFT: the FAB owns the right, and the left is the one corner of a
    // grocery list that never has anything in it.
    left: 14,
    bottom: 22,
    maxWidth: '62%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(241, 243, 245, 0.94)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dfe3e8',
  },
  pillText: { flexShrink: 1, fontSize: 11, color: '#5b6470' },
  conflictCard: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#fff4d9',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e8d08a',
    // It is sitting on top of the list rather than above it now, so it needs to
    // read as a layer of its own.
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
  },
  conflictText: { flex: 1, fontSize: 13, color: '#8a5a00', lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  undo: { fontSize: 13, fontWeight: '700', color: '#8a5a00' },
});
